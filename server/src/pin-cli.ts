import { PIN_FILE, PIN_MAX, PIN_MIN, removePin, validPin, writePin } from './pin.ts';

/**
 * Define ou remove o PIN do painel (chamado por `editr -pin`, ver deploy/editr.sh). O PIN chega pela
 * entrada padrão, e não como argumento, para não aparecer na lista de processos.
 */

if (process.argv[2] === 'off') {
  await removePin();
  console.log('PIN removido: o painel abre sem pedir PIN.');
  process.exit(0);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const pin = input.trim();
if (!validPin(pin)) {
  console.error(`O PIN precisa ter de ${PIN_MIN} a ${PIN_MAX} dígitos, só números.`);
  process.exit(1);
}
await writePin(pin);
console.log(`PIN gravado em ${PIN_FILE}. Vale na hora; os aparelhos destravados precisam digitar de novo.`);
