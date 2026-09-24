import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';

/** Multi-select of people: chips for the chosen ones plus a searchable picker to add more. */
export function PeoplePicker({
  people,
  value,
  onChange,
  disabled,
  id,
  exclude = [],
  placeholder = 'Add a person…',
}: {
  people: { id: string; name: string; email?: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  id?: string;
  exclude?: string[];
  placeholder?: string;
}) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const options = people.filter((p) => !value.includes(p.id) && !exclude.includes(p.id)).map((p) => ({ value: p.id, label: p.name, keywords: p.email }));
  return (
    <div className="grid gap-2">
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected people">
          {value.map((pid) => (
            <li key={pid}>
              <Badge variant="secondary" className="gap-1 py-1">
                {byId.get(pid)?.name ?? 'Unknown'}
                {!disabled ? (
                  <button type="button" className="rounded hover:text-destructive" aria-label={`Remove ${byId.get(pid)?.name ?? 'person'}`} onClick={() => onChange(value.filter((v) => v !== pid))}>
                    <X className="size-3" aria-hidden />
                  </button>
                ) : null}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {!disabled ? <Combobox id={id} options={options} value={null} onChange={(v) => v && onChange([...value, v])} placeholder={placeholder} searchPlaceholder="Search people…" /> : null}
    </div>
  );
}
