import { Check, ChevronsUpDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './command';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Extra text matched by search but not shown as the label. */
  keywords?: string;
  hint?: ReactNode;
  group?: string;
  disabled?: boolean;
}

/**
 * Searchable single-select (Radix Popover + cmdk). Keyboard: Enter/Space opens, type to
 * filter, arrows to move, Enter to pick, Escape to close.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches.',
  disabled,
  className,
  id,
  invalid,
  allowClear,
  ...aria
}: {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  invalid?: boolean;
  allowClear?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  const groups = [...new Set(options.map((o) => o.group ?? ''))];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || aria['aria-invalid'] || undefined}
          aria-label={aria['aria-label']}
          aria-describedby={aria['aria-describedby']}
          className={cn(
            'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
            className,
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        <Command
          filter={(_value, search, keywords) => {
            // Substring match on the visible label and keywords (not the id).
            const hay = (keywords ?? []).join(' ').toLowerCase();
            const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
            return terms.every((t) => hay.includes(t)) ? 1 : 0;
          }}
        >
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {allowClear && value ? (
              <CommandGroup>
                <CommandItem
                  value="__clear__"
                  keywords={['clear', 'none']}
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  <span className="text-muted-foreground">Clear selection</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groups.map((g) => (
              <CommandGroup key={g || 'all'} heading={g || undefined}>
                {options
                  .filter((o) => (o.group ?? '') === g)
                  .map((o) => (
                    <CommandItem
                      key={o.value}
                      value={o.value}
                      keywords={[o.label, o.keywords ?? '', o.group ?? '']}
                      disabled={o.disabled}
                      onSelect={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                    >
                      <Check className={cn('size-4', o.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{o.label}</span>
                      {o.hint ? <span className="text-xs text-muted-foreground">{o.hint}</span> : null}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
