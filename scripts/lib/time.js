// scripts/lib/time.js
// Shared ET timezone helpers

export function getNYTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

export function getHHMM() {
  const ny = getNYTime();
  return ny.getHours() * 100 + ny.getMinutes();
}

export function getTodayStr() {
  return getNYTime().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function getHHMM_ET(isoTs) {
  const d = new Date(isoTs);
  const s = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number);
  return h * 100 + m;
}

export function getDateStr(isoTs) {
  const d = new Date(isoTs);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
