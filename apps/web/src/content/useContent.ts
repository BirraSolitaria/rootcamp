import { ContentVersionDto, ProgressDto } from '@rootcamp/api-contract';
import type { Catalog, Section } from '@rootcamp/content-schema';
import { useQuery } from '@tanstack/react-query';
import { ApiClientError, apiFetch } from '../api/client';

export const PROGRESS_KEY = ['progress'] as const;

const retry = (count: number, err: Error) => !(err instanceof ApiClientError) && count < 2;

/** `GET /api/content/version`: the active content hash and its public base url. */
export function useContentVersion() {
  return useQuery({
    queryKey: ['content', 'version'],
    queryFn: () => apiFetch('/api/content/version', undefined, ContentVersionDto),
    staleTime: Infinity,
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

/** `GET /api/progress` against the active version. */
export function useProgress() {
  return useQuery({
    queryKey: PROGRESS_KEY,
    queryFn: () => apiFetch('/api/progress', undefined, ProgressDto),
    retry,
  });
}
