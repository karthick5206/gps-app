import { GUIDE_SECTIONS } from '@veetracer/shared';
import pdfmake from 'pdfmake';
import { setupPdf } from '../reports/report-files';
import { guideDocument } from './guide.service';

describe('getting-started guide', () => {
  it('covers phone, own / shipped trackers, dashcam, assignment and alerts, with the right server ports', () => {
    const ids = GUIDE_SECTIONS.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['licences', 'phone', 'shipped', 'byod', 'dashcam', 'assign', 'alerts']));
    const all = JSON.stringify(GUIDE_SECTIONS);
    expect(all).toContain('SERVER,1,track.mintplus.co.in,5023,0#');
    expect(all).toContain('2005:5027');
    expect(all).toContain('Port: 6808');
  });

  it('renders to a PDF', async () => {
    setupPdf();
    const pdf = await pdfmake.createPdf(guideDocument('https://app.veetrax.com', { name: 'Vibhav Enterprise Solutions', phone: null, email: 'info@vaidhika.in' }, null)).getBuffer();
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(5000);
  });
});
