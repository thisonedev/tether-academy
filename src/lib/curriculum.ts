// Per-chapter numbering: each chapter resets at 01 so the strip
// stays scannable as the course grows

const COURSE_BASE = '/courses/qvac/en'

export function lessonHref(chapterSlug: string, lessonSlug: string): string {
  return `${COURSE_BASE}/${chapterSlug}/${lessonSlug}`
}

export function chapterHref(chapterSlug: string): string {
  return `${COURSE_BASE}/${chapterSlug}`
}

export type CurriculumLessonState = 'done' | 'current' | 'upcoming'

export interface CurriculumLesson {
  num: string
  title: string
  shortTitle?: string
  slug: string
  href?: string
}

export interface CurriculumChapter {
  num: string
  label: string
  slug: string
  href?: string
  lessons: CurriculumLesson[]
}

/** Top-level course descriptor for /courses. Add new courses here. */
export interface Course {
  slug: string
  name: string
  description: string
  href: string
  planned?: boolean
}

/** Single source of truth for /courses. Add new courses here. */
export const COURSES: Course[] = [
  {
    slug: 'qvac',
    name: 'QVAC',
    description: 'Local-first, peer-to-peer SDK for running AI models locally.',
    href: '/courses/qvac',
  },
  {
    slug: 'wdk',
    name: 'WDK',
    description: 'Open-source SDK for building self-custodial wallets.',
    href: '/courses/wdk',
    planned: true,
  },
  {
    slug: 'pears',
    name: 'Pears',
    description: 'A peer-to-peer platform for building mobile, desktop, and terminal apps.',
    href: '/courses/pears',
    planned: true,
  },
  {
    slug: 'plasma',
    name: 'Plasma',
    description: 'Purpose-built blockchain designed to make stablecoin payments fast, reliable, and low-cost at global scale.',
    href: '/courses/plasma',
    planned: true,
  },
]

export const CURRICULUM: CurriculumChapter[] = [
  {
    num: '01',
    label: 'Getting started',
    slug: 'getting-started',
    href: chapterHref('getting-started'),
    lessons: [
      {
        num: '01',
        title: 'Load your first model',
        slug: 'load-model',
        href: lessonHref('getting-started', 'load-model'),
      },
      {
        num: '02',
        title: 'Run a completion',
        slug: 'run-completion',
        href: lessonHref('getting-started', 'run-completion'),
      },
      {
        num: '03',
        title: 'Stream completion events',
        slug: 'stream-events',
        href: lessonHref('getting-started', 'stream-events'),
      },
      {
        num: '04',
        title: 'Read the stop reason from a completion',
        slug: 'stop-reasons',
        href: lessonHref('getting-started', 'stop-reasons'),
      },
      {
        num: '05',
        title: 'Unload the model from memory',
        slug: 'unload-model',
        href: lessonHref('getting-started', 'unload-model'),
      },
      {
        num: '06',
        title: 'Show download progress',
        slug: 'show-download-progress',
        href: lessonHref('getting-started', 'show-download-progress'),
      },
    ],
  },
  {
    num: '02',
    label: 'Text generation',
    slug: 'text-generation',
    href: chapterHref('text-generation'),
    lessons: [
      {
        num: '01',
        title: 'Capture thinking content from a completion',
        slug: 'thinking-content',
        href: lessonHref('text-generation', 'thinking-content'),
      },
      {
        num: '02',
        title: 'Send a multi-turn conversation',
        slug: 'multi-turn',
        href: lessonHref('text-generation', 'multi-turn'),
      },
      {
        num: '03',
        title: 'Use tool calls from a completion',
        slug: 'tool-calls',
        href: lessonHref('text-generation', 'tool-calls'),
      },
      {
        num: '04',
        title: 'Plug MCP into a completion',
        slug: 'mcp',
        href: lessonHref('text-generation', 'mcp'),
      },
      {
        num: '05',
        title: 'Stream raw tokens from a completion',
        slug: 'raw-output',
        href: lessonHref('text-generation', 'raw-output'),
      },
      {
        num: '06',
        title: 'Cache conversation state across turns',
        slug: 'kv-cache',
        href: lessonHref('text-generation', 'kv-cache'),
      },
      {
        num: '07',
        title: 'Run multiple completions in parallel',
        slug: 'concurrent',
        href: lessonHref('text-generation', 'concurrent'),
      },
      {
        num: '08',
        title: 'Handle event types in a completion stream',
        slug: 'event-types',
        href: lessonHref('text-generation', 'event-types'),
      },
    ],
  },
  {
    num: '03',
    label: 'Text embeddings',
    slug: 'text-embeddings',
    href: chapterHref('text-embeddings'),
    lessons: [
      {
        num: '01',
        title: 'Load an embedding model',
        slug: 'load-embedding-model',
        href: lessonHref('text-embeddings', 'load-embedding-model'),
      },
      {
        num: '02',
        title: 'Embed a single string',
        slug: 'embed-single-text',
        href: lessonHref('text-embeddings', 'embed-single-text'),
      },
      {
        num: '03',
        title: 'Embed many strings at once',
        slug: 'embed-many-strings',
        href: lessonHref('text-embeddings', 'embed-many-strings'),
      },
      {
        num: '04',
        title: 'Compare embeddings with cosine similarity',
        slug: 'cosine-similarity',
        href: lessonHref('text-embeddings', 'cosine-similarity'),
      },
      {
        num: '05',
        title: 'Build a tiny semantic search',
        slug: 'tiny-search',
        href: lessonHref('text-embeddings', 'tiny-search'),
      },
    ],
  },
  {
    num: '04',
    label: 'RAG',
    slug: 'rag',
    href: chapterHref('rag'),
    lessons: [
      {
        num: '01',
        title: 'Ingest documents into a workspace',
        slug: 'ingest-documents',
        href: lessonHref('rag', 'ingest-documents'),
      },
      {
        num: '02',
        title: 'Search a RAG workspace',
        slug: 'search-workspace',
        href: lessonHref('rag', 'search-workspace'),
      },
      {
        num: '03',
        title: 'Chunk documents for RAG',
        slug: 'chunk-documents',
        href: lessonHref('rag', 'chunk-documents'),
      },
      {
        num: '04',
        title: 'Reindex a RAG workspace after many writes',
        slug: 'reindex',
        href: lessonHref('rag', 'reindex'),
      },
      {
        num: '05',
        title: 'List and close workspaces',
        slug: 'list-and-close',
        href: lessonHref('rag', 'list-and-close'),
      },
      {
        num: '06',
        title: 'Save pre-computed embeddings to a RAG workspace',
        slug: 'save-embeddings',
        href: lessonHref('rag', 'save-embeddings'),
      },
      {
        num: '07',
        title: 'Delete documents from a RAG workspace',
        slug: 'delete-embeddings',
        href: lessonHref('rag', 'delete-embeddings'),
      },
      {
        num: '08',
        title: 'Delete a RAG workspace and its data',
        slug: 'delete-workspace',
        href: lessonHref('rag', 'delete-workspace'),
      },
      {
        num: '09',
        title: 'Build RAG with an external vector DB',
        slug: 'external-vector-db',
        href: lessonHref('rag', 'external-vector-db'),
      },
    ],
  },
  {
    num: '05',
    label: 'Fine-tuning',
    slug: 'fine-tuning',
    href: chapterHref('fine-tuning'),
    lessons: [
      {
        num: '01',
        title: 'Check if a model is fine-tunable',
        slug: 'check-eligibility',
        href: lessonHref('fine-tuning', 'check-eligibility'),
      },
      {
        num: '02',
        title: 'Run a fine-tune',
        slug: 'run-finetune',
        href: lessonHref('fine-tuning', 'run-finetune'),
      },
      {
        num: '03',
        title: 'Pause, resume, and cancel a fine-tune',
        slug: 'pause-resume-cancel',
        href: lessonHref('fine-tuning', 'pause-resume-cancel'),
      },
      {
        num: '04',
        title: 'Use the fine-tuned adapter at inference time',
        slug: 'use-adapter',
        href: lessonHref('fine-tuning', 'use-adapter'),
      },
    ],
  },
  {
    num: '06',
    label: 'Multimodal',
    slug: 'multimodal',
    href: chapterHref('multimodal'),
    lessons: [
      {
        num: '01',
        title: 'Load a multimodal model and projection',
        slug: 'load-pair',
        href: lessonHref('multimodal', 'load-pair'),
      },
      {
        num: '02',
        title: 'Send a single image to a completion',
        slug: 'send-image',
        href: lessonHref('multimodal', 'send-image'),
      },
      {
        num: '03',
        title: 'Compare multiple images in a completion',
        slug: 'compare-images',
        href: lessonHref('multimodal', 'compare-images'),
      },
    ],
  },
  {
    num: '07',
    label: 'Image generation',
    slug: 'image-generation',
    href: chapterHref('image-generation'),
    lessons: [
      {
        num: '01',
        title: 'Generate image with txt2img',
        slug: 'txt2img',
        href: lessonHref('image-generation', 'txt2img'),
      },
      {
        num: '02',
        title: 'Set image width, height, and steps',
        slug: 'size-and-steps',
        href: lessonHref('image-generation', 'size-and-steps'),
      },
      {
        num: '03',
        title: 'Track diffusion progress',
        slug: 'progress',
        href: lessonHref('image-generation', 'progress'),
      },
      {
        num: '04',
        title: 'Generate image with img2img',
        slug: 'img2img',
        href: lessonHref('image-generation', 'img2img'),
      },
      {
        num: '05',
        title: 'Generate image with FLUX.2-klein split layout',
        slug: 'flux2-split-layout',
        href: lessonHref('image-generation', 'flux2-split-layout'),
      },
      {
        num: '06',
        title: 'Generate image with Stable Diffusion',
        slug: 'stable-diffusion',
        href: lessonHref('image-generation', 'stable-diffusion'),
      },
      {
        num: '07',
        title: 'Upscale a generated image in the same call',
        slug: 'esrgan-postprocess',
        href: lessonHref('image-generation', 'esrgan-postprocess'),
      },
      {
        num: '08',
        title: 'Upscale an image with ESRGAN standalone',
        slug: 'esrgan-standalone',
        href: lessonHref('image-generation', 'esrgan-standalone'),
      },
    ],
  },
  {
    num: '08',
    label: 'Video generation',
    slug: 'video-generation',
    href: chapterHref('video-generation'),
    lessons: [
      {
        num: '01',
        title: 'Load a video model',
        slug: 'load-video-model',
        href: lessonHref('video-generation', 'load-video-model'),
      },
      {
        num: '02',
        title: 'Build a video from text',
        slug: 'txt2vid',
        href: lessonHref('video-generation', 'txt2vid'),
      },
      {
        num: '03',
        title: 'Build a video from a still image',
        slug: 'img2vid',
        href: lessonHref('video-generation', 'img2vid'),
      },
    ],
  },
  {
    num: '09',
    label: 'Transcription',
    slug: 'transcription',
    href: chapterHref('transcription'),
    lessons: [
      {
        num: '01',
        title: 'Transcribe an audio file',
        slug: 'transcribe-file',
        href: lessonHref('transcription', 'transcribe-file'),
      },
      {
        num: '02',
        title: 'Stream transcription from microphone',
        slug: 'mic-transcribe',
        href: lessonHref('transcription', 'mic-transcribe'),
      },
      {
        num: '03',
        title: 'Transcribe an audio file with a Whisper prompt',
        slug: 'whisper-prompt',
        href: lessonHref('transcription', 'whisper-prompt'),
      },
      {
        num: '04',
        title: 'Stream transcripts with VAD and end-of-turn events',
        slug: 'whisper-vad',
        href: lessonHref('transcription', 'whisper-vad'),
      },
      {
        num: '05',
        title: 'Transcribe multilingual audio with Parakeet TDT',
        slug: 'parakeet-tdt',
        href: lessonHref('transcription', 'parakeet-tdt'),
      },
      {
        num: '06',
        title: 'Transcribe English audio with Parakeet CTC',
        slug: 'parakeet-ctc',
        href: lessonHref('transcription', 'parakeet-ctc'),
      },
      {
        num: '07',
        title: 'Diarize speakers with Parakeet Sortformer',
        slug: 'parakeet-sortformer',
        href: lessonHref('transcription', 'parakeet-sortformer'),
      },
    ],
  },
  {
    num: '10',
    label: 'Text-to-speech',
    slug: 'text-to-speech',
    href: chapterHref('text-to-speech'),
    lessons: [
      {
        num: '01',
        title: 'Synthesize speech from text',
        slug: 'tts-synthesize',
        href: lessonHref('text-to-speech', 'tts-synthesize'),
      },
      {
        num: '02',
        title: 'Clone a voice with Chatterbox TTS',
        slug: 'chatterbox',
        href: lessonHref('text-to-speech', 'chatterbox'),
      },
      {
        num: '03',
        title: 'Synthesize multilingual speech with Supertonic',
        slug: 'supertonic-multilingual',
        href: lessonHref('text-to-speech', 'supertonic-multilingual'),
      },
      {
        num: '04',
        title: 'Stream TTS audio with bufferStream',
        slug: 'stream-tts-buffer',
        href: lessonHref('text-to-speech', 'stream-tts-buffer'),
      },
    ],
  },
  {
    num: '11',
    label: 'Translation',
    slug: 'translation',
    href: chapterHref('translation'),
    lessons: [
      {
        num: '01',
        title: 'Translate text between languages',
        slug: 'translate-text',
        href: lessonHref('translation', 'translate-text'),
      },
    ],
  },
  {
    num: '12',
    label: 'Voice assistant',
    slug: 'voice-assistant',
    href: chapterHref('voice-assistant'),
    lessons: [
      {
        num: '01',
        title: 'Build a real-time voice assistant loop',
        slug: 'voice-assistant-loop',
        href: lessonHref('voice-assistant', 'voice-assistant-loop'),
      },
      {
        num: '02',
        title: 'Stop the voice assistant from hearing itself',
        slug: 'voice-assistant-echo',
        href: lessonHref('voice-assistant', 'voice-assistant-echo'),
      },
    ],
  },
  {
    num: '13',
    label: 'OCR',
    slug: 'ocr',
    href: chapterHref('ocr'),
    lessons: [
      {
        num: '01',
        title: 'Extract text from an image',
        slug: 'ocr-image',
        href: lessonHref('ocr', 'ocr-image'),
      },
    ],
  },
  {
    num: '14',
    label: 'Image classification',
    slug: 'image-classification',
    href: chapterHref('image-classification'),
    lessons: [
      {
        num: '01',
        title: 'Classify an image',
        slug: 'classify-image',
        href: lessonHref('image-classification', 'classify-image'),
      },
    ],
  },
  {
    num: '15',
    label: 'BCI',
    slug: 'bci',
    href: chapterHref('bci'),
    lessons: [
      {
        num: '01',
        title: 'Batch decode a neural signal file',
        slug: 'bci-filesystem',
        href: lessonHref('bci', 'bci-filesystem'),
      },
      {
        num: '02',
        title: 'Stream-transcribe a sliding window over a neural signal',
        shortTitle: 'Stream a neural window',
        slug: 'bci-streaming',
        href: lessonHref('bci', 'bci-streaming'),
      },
    ],
  },
  {
    num: '16',
    label: 'VLA',
    slug: 'vla',
    href: chapterHref('vla'),
    lessons: [
      {
        num: '01',
        title: 'Run a SmolVLA action inference',
        slug: 'vla-smolvla',
        href: lessonHref('vla', 'vla-smolvla'),
      },
      {
        num: '02',
        title: 'Run a pi05 action inference',
        slug: 'vla-pi05',
        href: lessonHref('vla', 'vla-pi05'),
      },
    ],
  },
  {
    num: '17',
    label: 'P2P',
    slug: 'p2p',
    href: chapterHref('p2p'),
    lessons: [
      {
        num: '01',
        title: 'Pre-download a model with downloadAsset',
        slug: 'download-asset',
        href: lessonHref('p2p', 'download-asset'),
      },
      {
        num: '02',
        title: 'Connect through blind relays',
        slug: 'blind-relays',
        href: lessonHref('p2p', 'blind-relays'),
      },
    ],
  },
  {
    num: '18',
    label: 'Delegated inference',
    slug: 'delegated-inference',
    href: chapterHref('delegated-inference'),
    lessons: [
      {
        num: '01',
        title: 'Run a delegated-inference provider',
        slug: 'delegated-provider',
        href: lessonHref('delegated-inference', 'delegated-provider'),
      },
      {
        num: '02',
        title: 'Connect a delegated-inference consumer',
        slug: 'delegated-consumer',
        href: lessonHref('delegated-inference', 'delegated-consumer'),
      },
    ],
  },
]

/** Finds a chapter by its URL slug, or undefined. */
export function getCurriculumChapterBySlug(slug: string): CurriculumChapter | undefined {
  return CURRICULUM.find((c) => c.slug === slug)
}

/** Finds a lesson within a chapter by its slug. */
export function getCurriculumLessonBySlug(
  chapter: CurriculumChapter,
  slug: string,
): CurriculumLesson | undefined {
  return chapter.lessons.find((l) => l.slug === slug)
}

/** Returns the position state of a lesson relative to the current lesson in the same chapter. */
export function stateOf(
  lesson: CurriculumLesson,
  chapter: CurriculumChapter | undefined,
  currentLesson: CurriculumLesson | undefined,
): CurriculumLessonState {
  if (!chapter || !currentLesson) return 'upcoming'
  const curIdx = chapter.lessons.findIndex((l) => l.num === currentLesson.num)
  const myIdx = chapter.lessons.findIndex((l) => l.num === lesson.num)
  if (curIdx === -1 || myIdx === -1) return 'upcoming'
  if (myIdx < curIdx) return 'done'
  if (myIdx === curIdx) return 'current'
  return 'upcoming'
}
