/** Per-boundary ownership of the existing fragment strategy's in-flight work. */
import type { PayloadLivePreviewData } from '@/types/payload-protocol';
import { trustedHtml } from '@security/trusted-types';
import { isBindingInScope, messageOwnerKeys, readDocumentId } from './binding-owner';
import { ElementCache, resolveBindingOwner } from './cache';
import { parseDependencyList } from './dependencies';
import { bindingValue } from './field-value';
import { canPatchFragment } from './fragment-patches';
import { isInsideIsland } from './islands';
import { morphElement } from './morph';
import type { FragmentWork, RuntimeDeps, RuntimeState, UpdateTransaction } from './runtime-state';
import type { FragmentContext, FragmentStrategy } from './strategies';
import type { FragmentPlan, StrategyHost } from './strategy-runner';
import { KEY_ATTRIBUTE } from './structural-applier';

interface WorkHost extends StrategyHost {
  readonly fallback: (
    transaction: UpdateTransaction,
    data: PayloadLivePreviewData,
    boundary: Element,
  ) => void;
  readonly failure: (transaction: UpdateTransaction, boundary: Element, transient: boolean) => void;
  readonly retry: (
    transaction: UpdateTransaction,
    data: PayloadLivePreviewData,
    strategy: FragmentStrategy,
  ) => void;
}

function signature(boundary: Element): string {
  return JSON.stringify([
    boundary.getAttribute('data-payload-fragment'),
    boundary.getAttribute('data-payload-fragment-key'),
    boundary.getAttribute('data-payload-depends'),
    resolveBindingOwner(boundary),
  ]);
}

export class FragmentWorkRunner {
  constructor(
    private readonly deps: RuntimeDeps,
    private readonly state: RuntimeState,
    private readonly host: WorkHost,
  ) {}

  private inScope(boundary: Element, transaction: UpdateTransaction): boolean {
    return (
      !this.deps.scopeBindingsByOwner ||
      isBindingInScope(
        resolveBindingOwner(boundary),
        messageOwnerKeys({
          globalSlug: transaction.message.globalSlug,
          collectionSlug: transaction.message.collectionSlug,
          documentId: readDocumentId(
            transaction.latestData?.fields ?? transaction.message.data ?? {},
          ),
        }),
      )
    );
  }

  /** Consume the already computed diff before render debt is added to the plan. */
  reconcile(transaction: UpdateTransaction, requested: readonly Element[]): void {
    const data = transaction.latestData;
    if (data === undefined) return;
    const paths = new Set([...(transaction.changedPaths ?? []), ...transaction.invalidated]);
    if (!this.state.changes.trackingPaths) {
      for (const field of transaction.changedFields ?? transaction.touched) paths.add(field);
    }
    for (const work of this.state.fragmentWork.values()) {
      const boundary = work.boundary;
      if (!this.inScope(boundary, transaction)) {
        // A foreign descendant may progress, but its enclosing response cannot overwrite it.
        if (
          requested.some((element) => boundary.contains(element)) ||
          [...paths].some(
            (path) =>
              this.deps.cache
                .get(path)
                ?.some(
                  (target) =>
                    boundary.contains(target.element) && this.inScope(target.element, transaction),
                ) === true,
          )
        ) {
          work.valid = false;
          work.pending = false;
        }
        continue;
      }
      const parent =
        requested.some((element) => element !== boundary && element.contains(boundary)) ||
        this.parentOwed(boundary);
      const dependencies = parseDependencyList(boundary.getAttribute('data-payload-depends'));
      const relevant = new Set(
        [...paths].filter(
          (path) =>
            dependencies.length === 0 ||
            dependencies.some(
              (field) =>
                path === field || path.startsWith(field + '.') || field.startsWith(path + '.'),
            ),
        ),
      );
      const requiresServer =
        parent ||
        transaction.forceRender ||
        transaction.replayFragments === true ||
        transaction.baseline ||
        requested.some((element) => boundary.contains(element)) ||
        (work.transaction === transaction &&
          work.data !== data &&
          paths.size > 0 &&
          !canPatchFragment(this.deps, boundary, paths, transaction.structuralPaths)) ||
        (relevant.size > 0 &&
          !canPatchFragment(this.deps, boundary, relevant, transaction.structuralPaths));
      if (requiresServer) {
        work.valid = false;
        work.pending = !parent;
      } else {
        for (const path of relevant) work.paths.add(path);
      }
      if (work.transaction.fragmentFailures !== undefined) {
        transaction.fragmentFailures ??= new Map();
        const failures = work.transaction.fragmentFailures.get(boundary);
        if (failures !== undefined) transaction.fragmentFailures.set(boundary, failures);
      }
      work.transaction = transaction;
      work.data = data;
    }
  }

  private parentOwed(boundary: Element): boolean {
    let parent = boundary.parentElement?.closest('[data-payload-fragment]');
    while (parent != null) {
      if (
        this.state.fragmentRenderOwed.has(parent) &&
        resolveBindingOwner(parent) === resolveBindingOwner(boundary)
      ) {
        return true;
      }
      parent = parent.parentElement?.closest('[data-payload-fragment]');
    }
    return false;
  }

  async run(
    transaction: UpdateTransaction,
    data: PayloadLivePreviewData,
    plan: FragmentPlan,
  ): Promise<void> {
    await Promise.all(
      plan.boundaries.map((boundary) => {
        this.state.fragmentRenderOwed.add(boundary);
        if (this.parentOwed(boundary)) return Promise.resolve();
        const running = this.state.fragmentWork.get(boundary);
        if (running !== undefined) return running.promise ?? Promise.resolve();
        const work: FragmentWork = {
          boundary,
          strategy: plan.strategy,
          controller: new AbortController(),
          signature: signature(boundary),
          paths: new Set(),
          transaction,
          data,
          valid: true,
          pending: false,
        };
        this.state.fragmentWork.set(boundary, work);
        work.promise = this.render(work);
        return work.promise;
      }),
    );
  }

  abort(): void {
    const work = [...this.state.fragmentWork.values()];
    this.state.fragmentWork.clear();
    for (const entry of work) entry.controller.abort();
  }

  private current(work: FragmentWork): boolean {
    const active = this.state.activeUpdate;
    return (
      this.state.isRunning() &&
      this.state.fragmentWork.get(work.boundary) === work &&
      !work.controller.signal.aborted &&
      work.valid &&
      !work.transaction.cancelled &&
      this.deps.root.contains(work.boundary) &&
      signature(work.boundary) === work.signature &&
      active !== null &&
      (active === work.transaction || !this.inScope(work.boundary, active))
    );
  }

  /** Check the returned binding contract and rebase with the existing writers before morphing. */
  private morph(work: FragmentWork, html: string, patchFields?: readonly string[]): boolean {
    if (!this.current(work)) return false;
    const boundary = work.boundary;
    const template = boundary.ownerDocument.createElement('template');
    template.innerHTML = trustedHtml(html);
    const rendered = boundary.cloneNode(false) as Element;
    rendered.append(template.content);
    if (patchFields !== undefined) {
      rendered.setAttribute('data-payload-patch-fields', patchFields.join(','));
    }
    if (work.paths.size > 0) {
      const owner = resolveBindingOwner(boundary);
      const cache = new ElementCache({
        filter: (element) =>
          !isInsideIsland(element) &&
          (!this.deps.scopeBindingsByOwner || (resolveBindingOwner(element) ?? owner) === owner),
      });
      cache.buildFromRoot(rendered);
      if (rendered.hasAttribute('data-payload-field')) cache.add(rendered);
      if (!canPatchFragment({ ...this.deps, cache }, rendered, work.paths)) return false;
      for (const path of work.paths) {
        for (const target of cache.get(path) ?? []) {
          const value = bindingValue(work.data.fields, target, path, work.transaction.locale);
          if (value === undefined || !this.current(work)) return false;
          const transformed = this.host.transform(target, value, work.data.fields, () =>
            this.current(work),
          );
          if (
            !this.host.writeFragment(
              {
                target,
                value: transformed,
                allFields: work.data.fields,
                revision: work.transaction.revision,
                data: work.data,
              },
              work.transaction,
              () => this.current(work),
            )
          ) {
            return false;
          }
        }
      }
    }
    if (!this.current(work)) return false;
    for (const path of parseDependencyList(rendered.getAttribute('data-payload-patch-fields'))) {
      for (const target of this.deps.cache.get(path) ?? []) {
        if (boundary.contains(target.element)) {
          this.state.lastAppliedIdentity.delete(target.element);
        }
      }
    }
    morphElement(boundary, rendered, { keyAttributes: [KEY_ATTRIBUTE] });
    if (
      boundary.hasAttribute('data-payload-patch-fields') ||
      boundary.querySelector('[data-payload-fragment]') !== null
    ) {
      this.host.rebuildCache();
    }
    return this.current(work);
  }

  private satisfy(work: FragmentWork): void {
    for (const owed of this.state.fragmentRenderOwed) {
      if (
        owed === work.boundary ||
        work.boundary.contains(owed) ||
        !this.deps.root.contains(owed)
      ) {
        this.state.fragmentRenderOwed.delete(owed);
      }
    }
    work.transaction.fragmentFailures?.delete(work.boundary);
  }

  private async render(work: FragmentWork): Promise<void> {
    const { deps, state } = this;
    const input = work.transaction;
    const data = work.data;
    let applied = false;
    const didMorph = (): boolean => applied;
    const isCurrent = (): boolean => this.current(work);
    const context: FragmentContext = {
      root: deps.root,
      revision: input.revision.revision,
      receivedAt: input.receivedAt,
      fields: data.fields,
      locale: input.locale,
      collectionSlug:
        typeof input.message.collectionSlug === 'string' ? input.message.collectionSlug : undefined,
      globalSlug:
        typeof input.message.globalSlug === 'string' ? input.message.globalSlug : undefined,
      signal: work.controller.signal,
      isCurrent,
      log: (code, detail) => {
        deps.log('fragment', code, detail);
      },
      morph: (_boundary, html, patchFields) => {
        applied = this.morph(work, html, patchFields);
        if (!applied && isCurrent()) {
          work.valid = false;
          work.pending = true;
        }
      },
      patch: () => {
        if (isCurrent()) this.host.fallback(work.transaction, work.data, work.boundary);
      },
      rendered: (element, id, key) => {
        if (!isCurrent()) return;
        this.satisfy(work);
        void deps.emitter.emitWhile(
          'fragmentRender',
          {
            element,
            id,
            key,
            status: 'rendered',
            revision: work.transaction.revision.revision,
            receivedAt: work.transaction.receivedAt,
          },
          isCurrent,
        );
      },
      failed: (element, id, key, code, reason) => {
        if (!isCurrent()) return;
        this.host.failure(work.transaction, element, code === 'LP0801');
        const detail = `fragment "${id}" fell back to patch: ${reason}`;
        deps.log('fragment', code, detail);
        void deps.emitter.emitWhile(
          'error',
          { error: new Error(detail), context: 'fragment', code },
          isCurrent,
        );
        void deps.emitter.emitWhile(
          'fragmentRender',
          {
            element,
            id,
            key,
            status: 'failed',
            code,
            revision: work.transaction.revision.revision,
            receivedAt: work.transaction.receivedAt,
          },
          isCurrent,
        );
      },
    };
    let report = { rendered: 0, failed: 0, superseded: 0 };
    try {
      report = await work.strategy.render(context, [work.boundary]);
    } catch (error) {
      deps.log('fragment', 'LP0801', error);
      if (isCurrent()) {
        this.host.failure(work.transaction, work.boundary, true);
        this.host.fallback(work.transaction, work.data, work.boundary);
        report.failed = 1;
      }
    }
    let current = isCurrent();
    if (current && report.rendered > 0 && (didMorph() || work.paths.size === 0)) this.satisfy(work);
    else if (current && report.rendered > 0) {
      work.valid = false;
      work.pending = true;
      current = false;
    }
    state.fragmentStats.rendered += current ? report.rendered : 0;
    state.fragmentStats.failed += current ? report.failed : 0;
    state.fragmentStats.superseded += current ? report.superseded : 1;
    if (state.fragmentWork.get(work.boundary) !== work) return;
    state.fragmentWork.delete(work.boundary);
    const active = state.activeUpdate;
    if (active !== null) {
      active.pendingFragments = [...state.fragmentRenderOwed].filter((boundary) =>
        this.inScope(boundary, active),
      ).length;
    }
    if (
      work.pending &&
      state.isRunning() &&
      state.fragmentRenderOwed.has(work.boundary) &&
      !this.parentOwed(work.boundary) &&
      deps.root.contains(work.boundary) &&
      active !== null &&
      (active === work.transaction || !this.inScope(work.boundary, active))
    ) {
      void this.run(work.transaction, work.data, {
        strategy: work.strategy,
        boundaries: [work.boundary],
        covers: () => true,
      });
      return;
    }
    if (!current) return;
    this.host.retry(work.transaction, work.data, work.strategy);
    if (report.rendered > 0) this.host.restoreGuesses(work.transaction, work.data);
    if (active !== null && deps.scheduler.pendingCount === 0) state.complete(active);
    this.host.revealPending(work.transaction);
    if (report.rendered > 0 && deps.emitter.listenerCount('afterUpdate') > 0) {
      void deps.emitter.emitWhile(
        'afterUpdate',
        {
          data: work.data,
          updatedCount: report.rendered,
          durationMs: Date.now() - work.transaction.receivedAt,
          revision: work.transaction.revision.revision,
          receivedAt: work.transaction.receivedAt,
          source: 'fragment',
        },
        () => {
          const latest = state.activeUpdate;
          return (
            state.isRunning() &&
            !work.controller.signal.aborted &&
            latest !== null &&
            (latest === work.transaction || !this.inScope(work.boundary, latest))
          );
        },
      );
    }
  }
}
