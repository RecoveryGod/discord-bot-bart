const PREFIX = "[Bot]";

function timestamp() {
  return new Date().toISOString();
}

export function info(...args) {
  console.log(`${PREFIX} ${timestamp()}`, ...args);
}

export function error(...args) {
  console.error(`${PREFIX} ${timestamp()}`, ...args);
}
