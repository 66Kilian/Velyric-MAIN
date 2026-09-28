// Served from /theme.js so the markup stays identical for every visitor and a
// CDN can cache it. It runs before the first paint and reads the same cookie the
// preferences menu writes.
export function ThemeScript() {
  return <script src="/theme.js" />;
}
