export const JOIN_CODE_LENGTH = 8;
export const JOIN_CODE_GROUP_LENGTH = 4;
const JOIN_CODE_CHARACTERS = /[A-HJ-NP-Z2-9]/g;

export function normalizeJoinCodeInput(value: string) {
  return (value.toUpperCase().match(JOIN_CODE_CHARACTERS) ?? [])
    .join("")
    .slice(0, JOIN_CODE_LENGTH);
}
