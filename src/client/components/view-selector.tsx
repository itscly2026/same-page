import { Radio, RadioGroup } from "react-aria-components";

/** A mutually exclusive view choice with native arrow-key navigation. */
export function ViewSelector<T extends string>({ label, value, onChange, options, disabled = false, pending = false }: {
  label: string; value: T; onChange(value: T): void;
  options: readonly { id: T; label: string }[]; disabled?: boolean; pending?: boolean;
}) {
  return <RadioGroup className="view-selector" aria-label={label} orientation="horizontal" value={value}
    aria-busy={pending} isDisabled={disabled || pending} onChange={value => { const option = options.find(option => option.id === value); if (option) onChange(option.id); }}>
    {options.map(option => <Radio className="view-selector-option" key={option.id} value={option.id}>{option.label}</Radio>)}
  </RadioGroup>;
}
