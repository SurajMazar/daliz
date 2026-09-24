import { ImageUp } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function FileDropzone({
  accept,
  maxBytes,
  onFile,
  disabled,
  busy,
  title = 'Drop a file here, or click to browse',
  hint,
  onReject,
}: {
  accept: string[];
  maxBytes: number;
  onFile: (file: File) => void;
  onReject?: (message: string) => void;
  disabled?: boolean;
  busy?: boolean;
  title?: ReactNode;
  hint?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const hintId = useId();

  const handle = (file: File | undefined) => {
    if (!file) return;
    if (!accept.includes(file.type)) {
      onReject?.('That file type isn’t supported. Use PNG, JPEG, WebP or SVG.');
      return;
    }
    if (file.size > maxBytes) {
      onReject?.(`That file is too large. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      return;
    }
    onFile(file);
  };

  const inactive = disabled || busy;

  return (
    <div
      role="button"
      tabIndex={inactive ? -1 : 0}
      aria-disabled={inactive || undefined}
      aria-describedby={hintId}
      onClick={() => !inactive && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (inactive) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!inactive) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!inactive) handle(e.dataTransfer.files[0]);
      }}
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25',
        dragging ? 'border-primary bg-primary/5' : 'border-input hover:border-primary/60 hover:bg-muted/40',
        inactive && 'cursor-not-allowed opacity-60',
      )}
    >
      <div className={cn('flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary', busy && 'animate-pulse')}>
        <ImageUp className="size-5" aria-hidden />
      </div>
      <div className="text-sm font-medium">{busy ? 'Uploading and analysing…' : title}</div>
      {hint ? (
        <div id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </div>
      ) : (
        <span id={hintId} className="sr-only">
          Choose a file
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept.join(',')}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          handle(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
