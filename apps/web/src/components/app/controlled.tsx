import type { ReactElement } from 'react';
import { useController, type Control, type ControllerRenderProps, type FieldValues, type Path } from 'react-hook-form';

/**
 * A react-hook-form controller that forwards the id / aria-* props FormField injects, so
 * custom controls (money input, combobox, color input) get their label and error wiring.
 */
export function Controlled<T extends FieldValues, N extends Path<T>>({
  control,
  name,
  render,
  ...passthrough
}: {
  control: Control<T>;
  name: N;
  render: (field: ControllerRenderProps<T, N>, props: Record<string, unknown>) => ReactElement;
  [key: string]: unknown;
}) {
  const { field } = useController({ control, name });
  return render(field, passthrough);
}
