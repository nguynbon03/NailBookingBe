const fs = require('fs');
let c = fs.readFileSync('src/lib/booking-workflow.ts', 'utf8');

if (!c.includes('numPeople')) {
  c = c.replace(
    'export function serializeBooking(booking: any) {',
    'export function serializeBooking(booking: any) {\n  const base = {'
  );
  c = c.replace(
    'return {\n    ...booking,\n    totalPrice: Number(booking.totalPrice),',
    '  return {\n    ...booking,\n    totalPrice: Number(booking.totalPrice),\n    numPeople: booking.numPeople || 1,'
  );
}

fs.writeFileSync('src/lib/booking-workflow.ts', c);
console.log('serialize updated for numPeople');
