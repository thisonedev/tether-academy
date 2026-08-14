function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildManifest(course, chapters, lessonHtmlHref) {
  const orgId = `ORG-${course.slug}`;
  const manifestId = `tether-academy-${course.slug}`;

  const itemsXml = chapters
    .map((chapter) => {
      const lessonItems = chapter.lessons
        .map((lesson) => {
          const itemId = `ITEM-${chapter.slug}-${lesson.slug}`;
          const resId = `RES-${chapter.slug}-${lesson.slug}`;
          return `      <item identifier="${itemId}" identifierref="${resId}" isvisible="true">
        <title>${escapeXml(lesson.title)}</title>
      </item>`;
        })
        .join('\n');
      return `    <item identifier="ITEM-ch-${chapter.slug}" isvisible="true">
      <title>${escapeXml(chapter.label)}</title>
${lessonItems}
    </item>`;
    })
    .join('\n');

  const resourcesXml = chapters
    .flatMap((chapter) =>
      chapter.lessons.map((lesson) => {
        const resId = `RES-${chapter.slug}-${lesson.slug}`;
        const href = lessonHtmlHref(chapter.slug, lesson.slug);
        return `    <resource identifier="${resId}" type="webcontent" adlcp:scormtype="sco" href="${escapeXml(href)}">
      <file href="${escapeXml(href)}"/>
    </resource>`;
      }),
    )
    .join('\n');

  return `<?xml version="1.0" standalone="no"?>
<manifest identifier="${manifestId}" version="1"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="${orgId}">
    <organization identifier="${orgId}">
      <title>${escapeXml(course.name)}</title>
${itemsXml}
    </organization>
  </organizations>
  <resources>
${resourcesXml}
  </resources>
</manifest>
`;
}

export function countLessons(chapters) {
  return chapters.reduce((sum, chapter) => sum + chapter.lessons.length, 0);
}
