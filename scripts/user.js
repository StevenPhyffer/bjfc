// Manage dashboard logins from the command line.
//   node scripts/user.js add <email> "<Name>"      (prompts for password)
//   node scripts/user.js passwd <email>             (prompts for new password)
//   node scripts/user.js list
import readline from "node:readline";
import { loadEnv } from "../lib/config.js";
import { addUser, setPassword, listUsers } from "../lib/auth.js";

loadEnv();
const [cmd, email, name] = process.argv.slice(2);

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(q) ? s : "");
    rl.question(q, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
  });
}

try {
  if (cmd === "list") console.table(listUsers());
  else if (cmd === "add" && email) {
    addUser({ email, name, password: process.env.NEW_PASSWORD || (await askHidden("Password (min 10 chars): ")) });
    console.log(`User ${email} added.`);
  } else if (cmd === "passwd" && email) {
    setPassword(email, process.env.NEW_PASSWORD || (await askHidden("New password (min 10 chars): ")));
    console.log(`Password updated for ${email}. Their other sessions are signed out.`);
  } else console.log('Usage: node scripts/user.js add <email> "<Name>" | passwd <email> | list');
} catch (e) {
  console.error("Error:", e.message);
  process.exit(1);
}
