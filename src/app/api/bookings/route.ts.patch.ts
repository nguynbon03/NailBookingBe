const fs = require('fs');
let c = fs.readFileSync('src/app/api/bookings/route.ts', 'utf8');

// Accept numPeople in body
const bodyParse = c.indexOf('const body = await req.json();');
if (bodyParse !== -1) {
  c = c.replace(
    'const body = await req.json();',
    'const body = await req.json();\n    const numPeople = Math.max(1, Math.min(10, parseInt(body.numPeople || "1", 10) || 1));'
  );
}

// After serviceKeys, adjust total price later
// Find the part where totalPrice is calculated
c = c.replace(
  /const totalPrice = services\.reduce\(.*?\n.*?\n.*?\);/s,
  `const totalPrice = services.reduce((sum: number, item: any) => sum + Number(item.price || 0), 0) * numPeople;`
);

// Add numPeople to data when creating
c = c.replace(
  /const booking = await tx\.booking\.create\(\s*\{[\s\S]*?data: \{[\s\S]*?notes: notes,[\s\S]*?}/,
  (match) => match.replace(/notes: notes,/, 'notes: notes,\n            numPeople,')
);

fs.writeFileSync('src/app/api/bookings/route.ts', c);
console.log('Patched bookings route for numPeople');
