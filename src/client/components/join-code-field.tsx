import { Input, Label, TextField } from "react-aria-components";

import {
  JOIN_CODE_GROUP_LENGTH,
  JOIN_CODE_LENGTH,
  normalizeJoinCodeInput,
} from "./join-code";

function formatJoinCodeInput(value: string) {
  return value.length > JOIN_CODE_GROUP_LENGTH
    ? `${value.slice(0, JOIN_CODE_GROUP_LENGTH)}-${value.slice(JOIN_CODE_GROUP_LENGTH)}`
    : value;
}

export function JoinCodeField(props: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const activeIndex = Math.min(props.value.length, JOIN_CODE_LENGTH - 1);

  return (
    <TextField
      className="join-code-field"
      isRequired
      value={formatJoinCodeInput(props.value)}
      onChange={(value) => props.onChange(normalizeJoinCodeInput(value))}
    >
      <Label>邀请码</Label>
      <div className="join-code-control">
        <Input
          className="join-code-input"
          aria-label="邀请码"
          autoFocus={props.autoFocus}
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={32}
          spellCheck={false}
        />
        <div className="join-code-slots" aria-hidden="true">
          <CodeGroup
            value={props.value}
            offset={0}
            activeIndex={activeIndex}
          />
          <span className="join-code-separator">–</span>
          <CodeGroup
            value={props.value}
            offset={JOIN_CODE_GROUP_LENGTH}
            activeIndex={activeIndex}
          />
        </div>
      </div>
    </TextField>
  );
}

function CodeGroup(props: {
  value: string;
  offset: number;
  activeIndex: number;
}) {
  return (
    <span className="join-code-group">
      {Array.from({ length: JOIN_CODE_GROUP_LENGTH }, (_, groupIndex) => {
        const index = props.offset + groupIndex;
        return (
          <span
            className="join-code-slot"
            data-active={index === props.activeIndex || undefined}
            data-filled={Boolean(props.value[index]) || undefined}
            key={index}
          >
            {props.value[index] ?? ""}
          </span>
        );
      })}
    </span>
  );
}
