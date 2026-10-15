// Icon markup for the RobotFac3 UI: a 24 px grid and a 2 px stroke, the same set as the Figma library.
// Names are fixed strings from this codebase. Nothing here is built from page text or user input.
const PATHS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
  "arrow-left": '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5"/><path d="M20 4v4.5h-4.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  "more-vertical": '<g fill="currentColor"><circle cx="12" cy="5.5" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="12" cy="18.5" r="1.25"/></g>',
  home: '<path d="M4 11l8-7 8 7v8.5a.5.5 0 0 1-.5.5H14.5v-6h-5v6H4.5a.5.5 0 0 1-.5-.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pause: '<path d="M8.5 6v12M15.5 6v12" stroke-width="3"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  more: '<g fill="currentColor"><circle cx="5.5" cy="12" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="18.5" cy="12" r="1.25"/></g>',
  settings: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.28 5.28l2.12 2.12M16.6 16.6l2.12 2.12M5.28 18.72l2.12-2.12M16.6 7.4l2.12-2.12"/>',
  send: '<path d="M4.5 11.5l15-7-6 15.5-2.5-6.5z" fill="currentColor"/>',
  wallet: '<path d="M17 8V5H6.5A2.5 2.5 0 0 0 4 7.5V10"/><rect x="4" y="8" width="16" height="11" rx="2"/><path d="M15.5 13.5h.5"/>',
  token: '<circle cx="12" cy="12" r="8"/><path d="M12 8l4 4-4 4-4-4z"/>',
  network: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.9l7.6-3.8M8.2 13.1l7.6 3.8"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.3 3.5 5 3.5 8s-1 5.7-3.5 8c-2.5-2.3-3.5-5-3.5-8s1-5.7 3.5-8z"/>',
  sparkle: '<path d="M12 3c.6 4.6 3.4 7.4 9 9-5.6 1.6-8.4 4.4-9 9-.6-4.6-3.4-7.4-9-9 5.6-1.6 8.4-4.4 9-9z" fill="currentColor"/>',
  stack: '<ellipse cx="12" cy="6.5" rx="7" ry="2.5"/><path d="M5 6.5V12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6.5M5 12v5.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V12"/>',
  ghost: '<path fill="currentColor" fill-rule="evenodd" stroke="none" d="M5 20v-9a7 7 0 0 1 14 0v9l-2.33-2-2.33 2L12 18l-2.33 2-2.34-2zM9.5 9a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zM14.5 9a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5z"/>',
  flower: '<g fill="currentColor" stroke="none"><circle cx="12" cy="6.5" r="3"/><circle cx="17.5" cy="12" r="3"/><circle cx="12" cy="17.5" r="3"/><circle cx="6.5" cy="12" r="3"/></g>',
  clipboard: '<rect x="6" y="5" width="12" height="15" rx="2"/><path d="M9.5 5V3.5h5V5M9.5 11h5M9.5 15h5"/>',
  file: '<path d="M7.5 3.5H14l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V4a.5.5 0 0 1 .5-.5z"/><path d="M14 3.5V8h4"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5L19 4M15.5 7.5L18 10"/>',
  activity: '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.75 1.75M16.95 16.95l1.75 1.75M5.3 18.7l1.75-1.75M16.95 7.05l1.75-1.75"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
};

export function icon(name, size = 18) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ""}</svg>`;
}
