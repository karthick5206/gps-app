import sharp from 'sharp';
import { stampLines, stampSelfie } from './selfie-stamp';

const details = { name: 'Ravi Kumar', when: '06 Nov 2026, 09:25 am', address: 'Anna Salai, Teynampet, Chennai, Tamil Nadu 600018', lat: 13.0426, lng: 80.2486 };

describe('stampLines', () => {
  it('who and when, where, then the coordinates', () => {
    expect(stampLines(details)).toEqual(['Ravi Kumar · 06 Nov 2026, 09:25 am', 'Anna Salai, Teynampet, Chennai, Tamil Nadu 600018', '13.042600, 80.248600']);
  });
  it('no address and no position: says so instead of leaving it out', () => {
    expect(stampLines({ ...details, address: null, lat: null, lng: null })).toEqual(['Ravi Kumar · 06 Nov 2026, 09:25 am', 'Location not available']);
  });
});

describe('stampSelfie', () => {
  it('keeps the size, writes a JPEG and darkens the bottom for the text', async () => {
    const photo = await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 240, g: 200, b: 160 } } }).png().toBuffer();
    const out = await stampSelfie(photo, details);
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 600, height: 800 });
    // stats() reads the whole input, so each strip is cut out first.
    const strip = async (top: number, height: number) => sharp(await sharp(out).extract({ left: 0, top, width: 600, height }).toBuffer()).stats();
    const top = await strip(0, 50);
    const bottom = await strip(760, 40);
    // A colour photo (as phones take): the top stays as it was, only the band at the bottom is darker.
    expect(Math.abs(top.channels[0].mean - 240)).toBeLessThan(4);
    expect(bottom.channels[0].mean).toBeLessThan(top.channels[0].mean - 60);
  });

  it('turns a sideways phone photo upright first', async () => {
    const sideways = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(await sharp(await stampSelfie(sideways, details)).metadata()).toMatchObject({ width: 600, height: 800 });
  });
});
