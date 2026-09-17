import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  AuthenticationError,
  InvalidCredentialsError,
  RateLimitAuthenticationError,
  login,
} from './auth.js';
import { exportCalendar } from './exporter.js';
import { TimeTreeApi } from './timetreeApi.js';

function printHelp(): void {
  console.log(`Usage: npm run timetree:export -- [options]

Options:
  -o, --output <path>       Path of the output .ics file (default: ./timetree.ics)
  -e, --email <email>       TimeTree login email (else TIMETREE_EMAIL env or prompt)
  -c, --calendar-code <c>   Calendar code from the calendar's TimeTree URL
      --list-labels         List the calendar's labels and exit
      --split-by-label      Write one .ics file per label instead of one combined file
      --include-comments    Also fetch and export per-event comments (slower, extra requests)
      --include-images      Also download per-event images (slower, extra requests)
      --num-workers <n>     Concurrent requests for comments/images (default: 10)
  -v, --verbose              More log output
  -h, --help                 Show this help

The password is read from TIMETREE_PASSWORD or prompted interactively
(masked) - it is never written to disk or logged. This tool uses TimeTree's
unofficial, reverse-engineered web API (not affiliated with or supported by
TimeTree) and can break at any time if TimeTree changes their app.
`);
}

async function promptEmail(): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question('TimeTree email: ')).trim();
  } finally {
    rl.close();
  }
}

function promptPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write('TimeTree password: ');
    const isTty = Boolean(stdin.isTTY);
    const wasRaw = isTty ? stdin.isRaw : false;
    if (isTty) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      if (isTty) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      const char = chunk.toString();
      if (char === '\n' || char === '\r' || char === '') {
        cleanup();
        stdout.write('\n');
        resolve(password);
        return;
      }
      if (char === '') {
        cleanup();
        reject(new Error('Aborted'));
        return;
      }
      if (char === '' || char === '\b') {
        password = password.slice(0, -1);
        return;
      }
      password += char;
    };
    stdin.on('data', onData);
  });
}

async function resolveEmail(cliEmail: string | undefined): Promise<string> {
  return cliEmail || process.env.TIMETREE_EMAIL || (await promptEmail());
}

async function resolvePassword(): Promise<string> {
  return process.env.TIMETREE_PASSWORD || (await promptPassword());
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      output: { type: 'string', short: 'o', default: 'timetree.ics' },
      email: { type: 'string', short: 'e' },
      'calendar-code': { type: 'string', short: 'c' },
      'list-labels': { type: 'boolean', default: false },
      'split-by-label': { type: 'boolean', default: false },
      'include-comments': { type: 'boolean', default: false },
      'include-images': { type: 'boolean', default: false },
      'num-workers': { type: 'string', default: '10' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const email = await resolveEmail(values.email);
  const password = await resolvePassword();

  console.log('Signing in to TimeTree...');
  let sessionId: string;
  try {
    sessionId = await login(email, password);
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      console.error('Error: wrong email or password.');
    } else if (err instanceof RateLimitAuthenticationError) {
      console.error('Error: rate limited by TimeTree, please try again later.');
    } else if (err instanceof AuthenticationError) {
      console.error(`Login error: ${err.message}`);
    } else {
      throw err;
    }
    process.exitCode = 1;
    return;
  }

  const api = new TimeTreeApi(sessionId);
  const calendars = await api.getMetadata();
  if (calendars.length === 0) {
    console.error('No calendars found on this account.');
    process.exitCode = 1;
    return;
  }

  const calendarCode = values['calendar-code'];
  const calendar = calendarCode
    ? calendars.find((c) => c.alias_code === calendarCode || String(c.id) === calendarCode)
    : calendars.length === 1
      ? calendars[0]
      : undefined;

  if (!calendar) {
    console.error('Please pick a calendar with --calendar-code. Available calendars:');
    for (const c of calendars) {
      console.error(`  - ${c.name} (code from URL: ${c.alias_code ?? 'unknown'}, id: ${c.id})`);
    }
    process.exitCode = 1;
    return;
  }

  if (values.verbose) {
    console.log(`Using calendar '${calendar.name}' (id ${calendar.id})`);
  }

  const labels = await api.getLabels(calendar.id);

  if (values['list-labels']) {
    if (labels.size === 0) {
      console.log('No labels found.');
      return;
    }
    let i = 1;
    for (const label of labels.values()) {
      console.log(`${i++}. ${label.name} (${label.color ?? 'no color'})`);
    }
    return;
  }

  await exportCalendar(api, calendar, labels, {
    output: values.output ?? 'timetree.ics',
    splitByLabel: Boolean(values['split-by-label']),
    includeComments: Boolean(values['include-comments']),
    includeImages: Boolean(values['include-images']),
    numWorkers: Number(values['num-workers']) || 10,
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
