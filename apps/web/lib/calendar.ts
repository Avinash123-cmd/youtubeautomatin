/** Local-browser month boundaries; the API receives explicit UTC instants. */
export function monthWindow(year: number, month: number) {
  return { from: new Date(year, month, 1).toISOString(), to: new Date(year, month + 1, 1).toISOString(), days: new Date(year, month + 1, 0).getDate(), offset: (new Date(year, month, 1).getDay() + 6) % 7 };
}
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
