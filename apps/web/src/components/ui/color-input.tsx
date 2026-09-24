import { useEffect, useId, useState } from 'react';
import { HEX_COLOR } from '@daliz/shared';
import { cn } from '@/lib/utils';
import { inputClass } from './input';

/**
 * A color picker paired with a hex text field. Only emits valid lowercase #rrggbb values,
 * which is the only color format the theme engine accepts.
 */
export function ColorInput({
  value,
  onChange,
  label,
  id,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (hex: string) => void;
  label: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const textInvalid = !HEX_COLOR.test(text.toLowerCase());

  return (
    <div className="flex items-center gap-2">
      <label
        className={cn(
          'relative size-9 shrink-0 overflow-hidden rounded-md border border-input shadow-xs focus-within:ring-[3px] focus-within:ring-ring/30',
          disabled && 'opacity-50',
        )}
        style={{ backgroundColor: HEX_COLOR.test(value) ? value : undefined }}
      >
        <span className="sr-only">{label} color picker</span>
        <input
          type="color"
          value={HEX_COLOR.test(value) ? value : '#000000'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
      <input
        id={inputId}
        className={cn(inputClass, 'font-mono uppercase')}
        value={text}
        disabled={disabled}
        maxLength={7}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${label} hex value`}
        aria-invalid={textInvalid || invalid || undefined}
        onChange={(e) => {
          let v = e.target.value.trim().toLowerCase();
          if (v && !v.startsWith('#')) v = `#${v}`;
          setText(v);
          if (HEX_COLOR.test(v)) onChange(v);
        }}
        onBlur={() => setText(value)}
      />
    </div>
  );
}
