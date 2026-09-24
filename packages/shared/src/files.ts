/**
 * Files / library contract.
 */
import { z } from 'zod';

/** Display names: no path separators, control characters or reserved names. */
export const fileNameSchema = z
  .string()
  .transform((v) => v.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, 'Required')
      .max(200, 'At most 200 characters')
      .refine((v) => !/[\\/\u0000-\u001f\u007f]/.test(v), 'Names can’t contain slashes or control characters')
      .refine((v) => v !== '.' && v !== '..', 'Not a valid name'),
  );

export const FILE_CATEGORIES = ['document', 'spreadsheet', 'presentation', 'pdf', 'image', 'text', 'archive', 'media'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export interface AllowedFileType {
  ext: string;
  mime: string;
  category: FileCategory;
  /** Extensions file-type may legitimately detect for this format (OOXML is a zip, etc.). */
  signatures: readonly string[] | 'text';
  /** Safe to show inline in the browser. SVG and HTML never are. */
  previewable: boolean;
}

export const ALLOWED_FILE_TYPES: readonly AllowedFileType[] = [
  { ext: 'pdf', mime: 'application/pdf', category: 'pdf', signatures: ['pdf'], previewable: true },
  { ext: 'png', mime: 'image/png', category: 'image', signatures: ['png'], previewable: true },
  { ext: 'jpg', mime: 'image/jpeg', category: 'image', signatures: ['jpg'], previewable: true },
  { ext: 'jpeg', mime: 'image/jpeg', category: 'image', signatures: ['jpg'], previewable: true },
  { ext: 'gif', mime: 'image/gif', category: 'image', signatures: ['gif'], previewable: true },
  { ext: 'webp', mime: 'image/webp', category: 'image', signatures: ['webp'], previewable: true },
  { ext: 'heic', mime: 'image/heic', category: 'image', signatures: ['heic'], previewable: false },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', category: 'document', signatures: ['docx', 'zip'], previewable: false },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', category: 'spreadsheet', signatures: ['xlsx', 'zip'], previewable: false },
  { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', category: 'presentation', signatures: ['pptx', 'zip'], previewable: false },
  { ext: 'doc', mime: 'application/msword', category: 'document', signatures: ['cfb', 'doc'], previewable: false },
  { ext: 'xls', mime: 'application/vnd.ms-excel', category: 'spreadsheet', signatures: ['cfb', 'xls'], previewable: false },
  { ext: 'ppt', mime: 'application/vnd.ms-powerpoint', category: 'presentation', signatures: ['cfb', 'ppt'], previewable: false },
  { ext: 'odt', mime: 'application/vnd.oasis.opendocument.text', category: 'document', signatures: ['odt', 'zip'], previewable: false },
  { ext: 'ods', mime: 'application/vnd.oasis.opendocument.spreadsheet', category: 'spreadsheet', signatures: ['ods', 'zip'], previewable: false },
  { ext: 'odp', mime: 'application/vnd.oasis.opendocument.presentation', category: 'presentation', signatures: ['odp', 'zip'], previewable: false },
  { ext: 'csv', mime: 'text/csv', category: 'text', signatures: 'text', previewable: false },
  { ext: 'txt', mime: 'text/plain', category: 'text', signatures: 'text', previewable: false },
  { ext: 'md', mime: 'text/markdown', category: 'text', signatures: 'text', previewable: false },
  { ext: 'json', mime: 'application/json', category: 'text', signatures: 'text', previewable: false },
  { ext: 'zip', mime: 'application/zip', category: 'archive', signatures: ['zip'], previewable: false },
  { ext: 'mp3', mime: 'audio/mpeg', category: 'media', signatures: ['mp3'], previewable: false },
  { ext: 'mp4', mime: 'video/mp4', category: 'media', signatures: ['mp4', 'm4v'], previewable: false },
  { ext: 'mov', mime: 'video/quicktime', category: 'media', signatures: ['mov', 'qt'], previewable: false },
];

export function fileTypeForName(name: string): AllowedFileType | undefined {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return ALLOWED_FILE_TYPES.find((t) => t.ext === ext);
}

export const createFolderSchema = z.object({
  name: fileNameSchema,
  parentId: z.string().uuid().nullable().default(null),
  visibility: z.enum(['workspace', 'restricted']).default('workspace'),
});

export const updateFolderSchema = z.object({
  name: fileNameSchema.optional(),
  parentId: z.string().uuid().nullable().optional(),
  visibility: z.enum(['workspace', 'restricted']).optional(),
  version: z.number().int().min(1),
});

export const updateFileSchema = z.object({
  name: fileNameSchema.optional(),
  folderId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(1000).optional(),
  version: z.number().int().min(1),
});

export const copyFileSchema = z.object({
  folderId: z.string().uuid().nullable(),
  name: fileNameSchema.optional(),
});

export const shareSchema = z.object({
  principalType: z.enum(['user', 'role']),
  principalId: z.string().uuid(),
  access: z.enum(['view', 'edit']),
});

export const fileQuerySchema = z.object({
  folderId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  category: z.enum(FILE_CATEGORIES).optional(),
  sort: z.enum(['name', 'size', 'updated']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export interface Person {
  id: string;
  name: string;
}

export interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
  visibility: 'workspace' | 'restricted';
  /** Effective: true if this folder or an ancestor is restricted. */
  restricted: boolean;
  canEdit: boolean;
  createdBy: Person | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
}

export interface FileRow {
  id: string;
  folderId: string | null;
  name: string;
  extension: string;
  mimeType: string;
  category: FileCategory;
  sizeBytes: number;
  previewable: boolean;
  versionCount: number;
  scanStatus: 'pending' | 'clean' | 'infected' | 'error';
  description: string;
  canEdit: boolean;
  createdBy: Person | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
}

export interface FileVersionRow {
  id: string;
  versionNo: number;
  sizeBytes: number;
  sha256: string;
  originalName: string;
  scanStatus: FileRow['scanStatus'];
  uploadedBy: Person | null;
  createdAt: string;
  current: boolean;
}

export interface FileShareRow {
  id: string;
  principalType: 'user' | 'role';
  principalId: string;
  principalName: string;
  access: 'view' | 'edit';
  createdAt: string;
}

export interface FolderContents {
  folder: FolderRow | null;
  breadcrumbs: { id: string; name: string }[];
  folders: FolderRow[];
  files: FileRow[];
  meta: { page: number; pageSize: number; total: number };
}

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number;
  fileCount: number;
  trashBytes: number;
}

export interface SignedUrl {
  url: string;
  expiresAt: string;
}

export interface ShareTargets {
  users: { id: string; name: string; email: string }[];
  roles: { id: string; name: string }[];
}
