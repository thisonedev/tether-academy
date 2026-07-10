import { docs } from '@/.source';
import { loader } from 'fumadocs-core/source';

export const source = loader({
  baseUrl: '/courses',
  source: docs.toFumadocsSource(),
});

export function getPage(params: { slug?: string[] }) {
  const slug = params.slug ?? [];
  return source.getPage(slug);
}
