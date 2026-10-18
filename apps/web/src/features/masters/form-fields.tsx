import { Controller, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Combobox, MultiSelect, type Option } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

interface BaseProps<V extends FieldValues> {
  form: UseFormReturn<V>;
  name: Path<V>;
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
}

function errorOf<V extends FieldValues>(form: UseFormReturn<V>, name: Path<V>): string | undefined {
  const e = name.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], form.formState.errors);
  return (e as { message?: string } | undefined)?.message;
}

export function TextField<V extends FieldValues>({
  form,
  name,
  label,
  required,
  hint,
  className,
  type = 'text',
  placeholder,
  autoComplete,
  multiline,
  disabled,
}: BaseProps<V> & { type?: string; placeholder?: string; autoComplete?: string; multiline?: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  const error = errorOf(form, name);
  const id = `f-${name}`;
  return (
    <Field label={t(label)} htmlFor={id} error={error && t(error)} hint={hint && t(hint)} required={required} className={className}>
      {multiline ? (
        <Textarea id={id} placeholder={placeholder && t(placeholder)} aria-invalid={!!error} {...form.register(name)} />
      ) : (
        <Input id={id} type={type} placeholder={placeholder && t(placeholder)} autoComplete={autoComplete} disabled={disabled} aria-invalid={!!error} {...form.register(name)} />
      )}
    </Field>
  );
}

export function SwitchField<V extends FieldValues>({ form, name, label, hint, className }: Omit<BaseProps<V>, 'required'>) {
  const { t } = useTranslation();
  const id = `f-${name}`;
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field }) => (
        <div className={className}>
          <label htmlFor={id} className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">{t(label)}</span>
              {hint && <span className="block text-xs text-muted-foreground">{t(hint)}</span>}
            </span>
            <Switch id={id} checked={!!field.value} onCheckedChange={field.onChange} />
          </label>
        </div>
      )}
    />
  );
}

export function SelectField<V extends FieldValues>({
  form,
  name,
  label,
  required,
  hint,
  className,
  options,
  placeholder = 'Select…',
}: BaseProps<V> & { options: Option[]; placeholder?: string }) {
  const { t } = useTranslation();
  const error = errorOf(form, name);
  const id = `f-${name}`;
  return (
    <Field label={t(label)} htmlFor={id} error={error && t(error)} hint={hint && t(hint)} required={required} className={className}>
      <Controller
        control={form.control}
        name={name}
        render={({ field }) => (
          <Select value={field.value ?? ''} onValueChange={field.onChange}>
            <SelectTrigger id={id} aria-invalid={!!error}>
              <SelectValue placeholder={t(placeholder)} />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {t(o.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
    </Field>
  );
}

interface PickerProps<V extends FieldValues> extends BaseProps<V> {
  options: Option[];
  loading?: boolean;
  onSearch?: (q: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function ComboboxField<V extends FieldValues>({
  form,
  name,
  label,
  required,
  hint,
  className,
  selectedOption,
  ...picker
}: PickerProps<V> & { selectedOption?: Option | null }) {
  const { t } = useTranslation();
  const error = errorOf(form, name);
  const id = `f-${name}`;
  return (
    <Field label={t(label)} htmlFor={id} error={error && t(error)} hint={hint && t(hint)} required={required} className={className}>
      <Controller
        control={form.control}
        name={name}
        render={({ field }) => (
          <Combobox id={id} invalid={!!error} value={field.value ?? null} onChange={field.onChange} selectedOption={selectedOption} clearable={!required} {...picker} placeholder={picker.placeholder && t(picker.placeholder)} />
        )}
      />
    </Field>
  );
}

export function MultiSelectField<V extends FieldValues>({
  form,
  name,
  label,
  required,
  hint,
  className,
  selectedOptions,
  ...picker
}: PickerProps<V> & { selectedOptions?: Option[] }) {
  const { t } = useTranslation();
  const error = errorOf(form, name);
  const id = `f-${name}`;
  return (
    <Field label={t(label)} htmlFor={id} error={error && t(error)} hint={hint && t(hint)} required={required} className={className}>
      <Controller
        control={form.control}
        name={name}
        render={({ field }) => (
          <MultiSelect id={id} invalid={!!error} value={field.value ?? []} onChange={field.onChange} selectedOptions={selectedOptions} {...picker} placeholder={picker.placeholder && t(picker.placeholder)} />
        )}
      />
    </Field>
  );
}
