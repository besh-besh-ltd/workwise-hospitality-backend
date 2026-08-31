import JWT from 'jsonwebtoken';
import Cryptr from 'cryptr';
import dotenv from 'dotenv';
dotenv.config();
const cryptr = new Cryptr(process.env.CRYPT_SECRET);
const now = Math.round(Date.now()/1000);
console.log(JWT.sign({iss:'Des Technico', sub: cryptr.encrypt(String(process.argv[2])), name:'e2e',
  session:'', user:true, ag: cryptr.encrypt('jest-test-agent'), iat: now, exp: now + 36000},
  process.env.JWT_SECRET));
