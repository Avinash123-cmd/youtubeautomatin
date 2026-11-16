import { CONFIG_KEYS } from '@clipforge/shared-types';
import { createJobSchema } from '@clipforge/validation';

/** Translate saved workspace settings to the actual API contract, before uploading any bytes. */
export function processingConfiguration(values: Record<string, unknown>, targetDurations: Array<15 | 30>) {
  const language = values[CONFIG_KEYS.SUBTITLE_LANGUAGE];
  const languages = values[CONFIG_KEYS.CONTENT_LANGUAGES];
  const parsed = createJobSchema.shape.configuration.safeParse({
      framingMode: values[CONFIG_KEYS.RENDER_FRAMING_MODE],
      framingFallback: values[CONFIG_KEYS.RENDER_FRAMING_FALLBACK] ?? 'fail',
      subtitlePresetId: values[CONFIG_KEYS.SUBTITLE_PRESET_ID],
      subtitleLanguage: language,
      contentLanguages: Array.isArray(languages) && languages.length ? languages : [language],
      targetDurations,
      maxClips: values[CONFIG_KEYS.AI_MAX_OUTPUT_CLIPS],
      minQualityScore: values[CONFIG_KEYS.AI_MIN_QUALITY_SCORE],
      // This UI explicitly queues review-only clips. Publishing remains a separate user action.
      autoPublish: false,
      platforms: [],
  });
  if (!parsed.success) throw new Error('Processing settings are incomplete or invalid. Select a duration and complete workspace configuration before uploading.');
  return parsed.data;
}

export function processingRequest(sourceVideoId: string, values: Record<string, unknown>, targetDurations: Array<15 | 30>) {
  return createJobSchema.parse({ sourceVideoId, configuration: processingConfiguration(values, targetDurations) });
}
