import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { FileRow, FileShareRow, FileVersionRow, FolderContents, FolderRow, SignedUrl, StorageUsage } from '@daliz/shared';
import { api, type Query } from '@/lib/api';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const filesKeys = {
  all: ['files'] as const,
  contents: (q: Query) => ['files', 'contents', q] as const,
  usage: ['files', 'usage'] as const,
  trash: ['files', 'trash'] as const,
  versions: (id: string) => ['files', 'versions', id] as const,
  shares: (kind: string, id: string) => ['files', 'shares', kind, id] as const,
};

export type Item = { kind: 'folder'; row: FolderRow } | { kind: 'file'; row: FileRow };

export function useFolderContents(q: Query, enabled = true) {
  return useQuery({
    queryKey: filesKeys.contents(q),
    queryFn: () => api.get<FolderContents>('/files', q),
    placeholderData: keepPreviousData,
    enabled,
    // Poll while any file is still being scanned for malware.
    refetchInterval: (query) => (query.state.data?.files.some((f) => f.scanStatus === 'pending') ? 3000 : false),
  });
}

export function useStorageUsage() {
  return useQuery({ queryKey: filesKeys.usage, queryFn: () => api.get<StorageUsage>('/files/usage') });
}

export function useTrash() {
  return useQuery({ queryKey: filesKeys.trash, queryFn: () => api.get<{ folders: FolderRow[]; files: FileRow[] }>('/files/trash') });
}

export function useVersions(id: string | null) {
  return useQuery({ queryKey: filesKeys.versions(id ?? ''), queryFn: () => api.get<FileVersionRow[]>(`/files/${id}/versions`), enabled: !!id });
}

export function useShares(kind: 'file' | 'folder', id: string | null) {
  return useQuery({
    queryKey: filesKeys.shares(kind, id ?? ''),
    queryFn: () => api.get<FileShareRow[]>(kind === 'file' ? `/files/${id}/shares` : `/files/folders/${id}/shares`),
    enabled: !!id,
  });
}

export async function downloadFile(id: string, versionId?: string): Promise<void> {
  const signed = await api.get<SignedUrl>(`/files/${id}/download`, versionId ? { versionId } : undefined);
  // The signed URL answers with Content-Disposition: attachment, so the page stays put.
  window.location.assign(signed.url);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
