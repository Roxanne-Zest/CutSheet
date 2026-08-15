/** Short unique ids. crypto.randomUUID where available, counter otherwise. */
let counter = 0;

export const uid = (prefix: string): string => {
  counter += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.floor(Math.random() * 0xffffffff).toString(16);
  return `${prefix}_${rand}${counter.toString(36)}`;
};
