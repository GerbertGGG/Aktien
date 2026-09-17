import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEvent } from './event.js';
import { buildCalendar, buildVEvent } from './ics.js';
import type { CalendarMetadata, LabelMap, TimeTreeApi } from './timetreeApi.js';

export interface ExportOptions {
  output: string;
  splitByLabel: boolean;
  includeComments: boolean;
  includeImages: boolean;
  numWorkers: number;
}

interface ImageManifestEntry {
  event_uuid: string;
  title: string;
  image_path: string;
  object_key: string;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      await fn(items[current]!);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
}

function calendarUserNames(metadata: CalendarMetadata): Map<number, string> {
  const names = new Map<number, string>();
  for (const user of metadata.calendar_users ?? []) {
    const id = user.user_id ?? user.id;
    if (id != null && user.name) names.set(id, user.name);
  }
  return names;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w-]/g, '_').replace(/^_+|_+$/g, '');
}

export async function exportCalendar(
  api: TimeTreeApi,
  metadata: CalendarMetadata,
  labels: LabelMap,
  options: ExportOptions,
): Promise<void> {
  const rawEvents = await api.getEvents(metadata.id);
  console.log(`Found ${rawEvents.length} events`);

  const events = rawEvents.map(parseEvent);

  if (options.includeComments || options.includeImages) {
    console.warn(
      'Exporting comments or images requires extra TimeTree requests per event ' +
        'and may take much longer or trigger rate limits.',
    );
    const userNames = calendarUserNames(metadata);
    const imageManifest: ImageManifestEntry[] = [];
    const outputDir = path.dirname(options.output);

    await mapLimit(events, options.numWorkers, async (event) => {
      if (options.includeComments) {
        event.comments = await api.getEventComments(metadata.id, event.uuid, userNames);
      }
      if (options.includeImages) {
        const images = await api.getEventImages(metadata.id, event.uuid);
        for (const image of images) {
          const fileName = sanitizeFilename(path.basename(image.objectKey)) || 'image';
          const imageOutputPath = path.join(outputDir, 'timetree_images', event.uuid, fileName);
          try {
            await api.downloadImage(image.objectKey, imageOutputPath);
            imageManifest.push({
              event_uuid: event.uuid,
              title: event.title,
              image_path: path.relative(outputDir, imageOutputPath),
              object_key: image.objectKey,
            });
          } catch (err) {
            console.warn(
              `Failed to download image for event ${event.uuid}: ${(err as Error).message}`,
            );
          }
        }
      }
    });

    if (options.includeImages) {
      const manifestPath = path.join(outputDir, 'timetree_images.json');
      await writeFile(manifestPath, `${JSON.stringify(imageManifest, null, 2)}\n`, 'utf8');
      console.log(`The image manifest is saved to ${path.resolve(manifestPath)}`);
    }
  }

  await mkdir(path.dirname(options.output), { recursive: true });

  if (options.splitByLabel) {
    const groups = new Map<number | null, string[][]>();
    for (const event of events) {
      const label = event.labelId != null ? labels.get(event.labelId) : undefined;
      const vevent = buildVEvent(event, label);
      if (!vevent) continue;
      const key = label ? event.labelId : null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(vevent);
    }

    const ext = path.extname(options.output) || '.ics';
    const base = options.output.slice(0, options.output.length - ext.length);
    let total = 0;
    for (const [key, veventLines] of groups) {
      const suffix = key == null ? 'unlabeled' : sanitizeFilename(labels.get(key)?.name || `label_${key}`);
      const filePath = `${base}_${suffix}${ext}`;
      await writeFile(filePath, buildCalendar(veventLines), 'utf8');
      console.log(`${veventLines.length} events for label '${suffix}' -> ${path.resolve(filePath)}`);
      total += veventLines.length;
    }
    console.log(`A total of ${total}/${events.length} events split into ${groups.size} files`);
    return;
  }

  const veventLines: string[][] = [];
  for (const event of events) {
    const label = event.labelId != null ? labels.get(event.labelId) : undefined;
    const vevent = buildVEvent(event, label);
    if (vevent) veventLines.push(vevent);
  }
  await writeFile(options.output, buildCalendar(veventLines), 'utf8');
  console.log(`A total of ${veventLines.length}/${events.length} events are added to the calendar`);
  console.log(`The .ics calendar file is saved to ${path.resolve(options.output)}`);
}
