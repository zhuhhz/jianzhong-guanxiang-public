import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

// Project-generated structural control, not an Illustrator export or design asset.
export async function aiContainer(useObjectStreams = false): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([200, 100]);
  document.catalog.set(PDFName.of('AIPrivateData'), PDFString.of('project-owned structural test'));
  const metadata = document.context.register(document.context.stream(
    'Illustrator structural fixture; not an Illustrator export', { Type: 'Metadata', Subtype: 'XML' }));
  document.catalog.set(PDFName.of('Metadata'), metadata);
  return document.save({ useObjectStreams });
}
