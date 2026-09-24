import type { FileCategory } from '@daliz/shared';
import { File, FileArchive, FileImage, FileMusic, FilePlay, FileSpreadsheet, FileText, Folder, FolderLock, Presentation } from 'lucide-react';
import { cn } from '@/lib/utils';

const ICONS: Record<FileCategory, typeof File> = {
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  pdf: FileText,
  image: FileImage,
  text: FileText,
  archive: FileArchive,
  media: FilePlay,
};

const TONES: Record<FileCategory, string> = {
  document: 'bg-primary/10 text-primary',
  spreadsheet: 'bg-success/10 text-success',
  presentation: 'bg-warning/10 text-warning',
  pdf: 'bg-destructive/10 text-destructive',
  image: 'bg-accent text-accent-foreground',
  text: 'bg-muted text-muted-foreground',
  archive: 'bg-muted text-muted-foreground',
  media: 'bg-accent text-accent-foreground',
};

export function FileIcon({ category, className, size = 'md' }: { category: FileCategory; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = category === 'media' ? FileMusic : ICONS[category];
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-md', TONES[category], size === 'sm' ? 'size-7' : size === 'lg' ? 'size-14' : 'size-9', className)}
      aria-hidden
    >
      <Icon className={size === 'lg' ? 'size-7' : 'size-4'} />
    </span>
  );
}

export function FolderIcon({ restricted, size = 'md' }: { restricted: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = restricted ? FolderLock : Folder;
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary', size === 'sm' ? 'size-7' : size === 'lg' ? 'size-14' : 'size-9')} aria-hidden>
      <Icon className={size === 'lg' ? 'size-7' : 'size-4'} />
    </span>
  );
}
