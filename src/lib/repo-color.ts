// Deterministic color per repository so the dashboard groups a repo's rows
// visually: the same `owner/repo` always maps to the same hue, different repos
// to different hues. Pure string hash → hue, no state, stable across renders.
export const repoHue = (key: string): number => {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 31 + key.charCodeAt(i)) % 360;
  }
  return h;
};

export const repoColor = (owner: string, repo: string): string =>
  `hsl(${repoHue(`${owner}/${repo}`)} 65% 50%)`;
