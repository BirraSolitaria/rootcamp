import { ContentVersionDto, ProgressDto } from '@rootcamp/api-contract';
import type { Catalog, PracticePublic, Section } from '@rootcamp/content-schema';
import { type QueryClient, useQueries, useQuery } from '@tanstack/react-query';
import { ApiClientError, apiFetch } from '../api/client';

export const PROGRESS_KEY = ['progress'] as const;
export const CONTENT_VERSION_KEY = ['content', 'version'] as const;

const retry = (count: number, err: Error) => !(err instanceof ApiClientError) && count < 2;

const fetchContentVersion = () => apiFetch('/api/content/version', undefined, ContentVersionDto);

/**
 * `GET /api/content/version`: the active content hash and its public base url. Cached until
 * something shows it moved on (`refreshContentVersion`): a session started on another version,
 * or `409 content_changed`.
 */
export function useContentVersion() {
  return useQuery({
    queryKey: CONTENT_VERSION_KEY,
    queryFn: fetchContentVersion,
    staleTime: Infinity,
    retry,
  });
}

/**
 * Refetches the active version now and resolves once the cache holds it (the content files
 * follow it). Progress is computed against the active version: it is refetched too.
 */
export function refreshContentVersion(qc: QueryClient): Promise<ContentVersionDto> {
  void qc.invalidateQueries({ queryKey: PROGRESS_KEY });
  return qc.fetchQuery({
    queryKey: CONTENT_VERSION_KEY,
    queryFn: fetchContentVersion,
    staleTime: 0,
    retry,
  });
}

/**
 * Public files of the active version (`/content/<v>/…`). A version's path never changes its
 * contents, so they are cached forever, keyed by version.
 */
function useVersionFile<T>(key: string, file: string | null): ContentFile<T> {
  const version = useContentVersion();
  const v = version.data;
  const query = useQuery({
    queryKey: ['content', v?.version, key],
    queryFn: () => apiFetch<T>(`${v?.baseUrl ?? ''}${file ?? ''}`),
    enabled: v !== undefined && file !== null,
    staleTime: Infinity,
    retry,
  });
  // A failed version request leaves the file query disabled: report its error instead.
  const error = version.error ?? query.error;
  return { data: query.data, error, isPending: query.data === undefined && error === null };
}

/** A public content file: `data` once loaded, or the error of the version or file request. */
export interface ContentFile<T> {
  data: T | undefined;
  error: Error | null;
  isPending: boolean;
}

/** `catalog.json` of the active version: all published tracks. */
export function useCatalog() {
  return useVersionFile<Catalog>('catalog', 'catalog.json');
}

/** `sections/<id>.json`, fetched on demand (§3: when a section or a lesson is opened). */
export function useSection(sectionId: string | null) {
  return useVersionFile<Section>(
    `section:${sectionId ?? ''}`,
    sectionId === null ? null : `sections/${sectionId}.json`,
  );
}

/** `practices/<id>.json`: the public part of a practice manifest (brief, goals, reward). */
export function usePracticeContent(practiceId: string) {
  return useVersionFile<PracticePublic>(`practice:${practiceId}`, `practices/${practiceId}.json`);
}

/**
 * Several `sections/<id>.json` at once (a review mixes tasks of many sections); same cache
 * entries as `useSection`. `data` once every file is loaded.
 */
export function useSections(sectionIds: readonly string[]): ContentFile<Section[]> {
  const version = useContentVersion();
  const v = version.data;
  const queries = useQueries({
    queries: sectionIds.map((id) => ({
      queryKey: ['content', v?.version, `section:${id}`],
      queryFn: () => apiFetch<Section>(`${v?.baseUrl ?? ''}sections/${id}.json`),
      enabled: v !== undefined,
      staleTime: Infinity,
      retry,
    })),
  });
  const error = version.error ?? queries.find((q) => q.error)?.error ?? null;
  const data = queries.every((q) => q.data !== undefined)
    ? queries.map((q) => q.data as Section)
    : undefined;
  return { data, error, isPending: data === undefined && error === null };
}

/** `GET /api/progress` against the active version. */
export function useProgress() {
  return useQuery({
    queryKey: PROGRESS_KEY,
    queryFn: () => apiFetch('/api/progress', undefined, ProgressDto),
    retry,
  });
}
