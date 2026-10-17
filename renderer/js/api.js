export const api = window.api;
export function currentUser() { return JSON.parse(sessionStorage.getItem('user') || 'null'); }
export function isManager() { const u = currentUser(); return u && u.role === 'manager'; }
