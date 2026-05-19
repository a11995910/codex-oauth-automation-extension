// data-names.js — random name and birthday generation

const FIRST_NAMES = [
  'James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Thomas', 'Christopher',
  'Mary', 'Patricia', 'Jennifer', 'Linda', 'Barbara', 'Elizabeth', 'Susan', 'Jessica', 'Sarah', 'Karen',
  'Daniel', 'Matthew', 'Anthony', 'Mark', 'Donald', 'Steven', 'Andrew', 'Paul', 'Joshua', 'Kenneth',
  'Emma', 'Olivia', 'Ava', 'Isabella', 'Sophia', 'Mia', 'Charlotte', 'Amelia', 'Harper', 'Evelyn',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
];

function generateRandomName() {
  const firstName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return { firstName, lastName };
}

function generateRandomBirthday() {
  const currentYear = new Date().getFullYear();
  const age = 19 + Math.floor(Math.random() * 7); // 19 to 25
  const year = currentYear - age;
  const month = 1 + Math.floor(Math.random() * 12);
  const maxDay = new Date(year, month, 0).getDate();
  const day = 1 + Math.floor(Math.random() * maxDay);
  return { year, month, day };
}

function generatePassword(length = 16) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%^&*';
  const all = upper + lower + digits + special;

  let pwd = '';
  pwd += upper[Math.floor(Math.random() * upper.length)];
  pwd += lower[Math.floor(Math.random() * lower.length)];
  pwd += digits[Math.floor(Math.random() * digits.length)];
  pwd += special[Math.floor(Math.random() * special.length)];
  for (let i = 4; i < length; i++) {
    pwd += all[Math.floor(Math.random() * all.length)];
  }
  return pwd.split('').sort(() => Math.random() - 0.5).join('');
}

module.exports = { generateRandomName, generateRandomBirthday, generatePassword };
