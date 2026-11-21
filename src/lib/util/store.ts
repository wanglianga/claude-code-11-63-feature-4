import { useSyncExternalStore } from 'react';

type Listener = () => void;

export interface Store<T> {
  get: () => T;
  /** Replace the whole state. */
  set: (next: T) => void;
  /** Functional update; preferred form. */
  update: (updater: (prev: T) => T) => void;
  subscribe: (fn: Listener) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener>();
  const commit = (next: T) => {
    if (next === state) return;
    state = next;
    for (const fn of listeners) fn();
  };
  return {
    get: () => state,
    set: commit,
    update: (updater) => commit(updater(state)),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function useStore<T>(store: Store<T>): T;
export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): S;
export function useStore<T, S>(store: Store<T>, selector?: (state: T) => S): T | S {
  return useSyncExternalStore(
    store.subscribe,
    () => (selector ? selector(store.get()) : store.get()),
    () => (selector ? selector(store.get()) : store.get()),
  );
}
