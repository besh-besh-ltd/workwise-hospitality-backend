import { qrSvg, barcodeSvg } from '../../app/services/inventory/qr.js';
import { shortUrl } from '../../app/services/inventory/shortUrl.js';
import {
  inventoryGrn,
  inventoryPoDeliveries,
  inventoryAdjustment,
  inventoryCount,
  inventoryReorder,
  vendorPoDeliveries,
} from '../../app/services/notificationLinks.js';

describe('inventory qr helpers', () => {
  it('qrSvg returns an svg string', () => {
    const svg = qrSvg('https://example.com/s/g/12');
    expect(typeof svg).toBe('string');
    expect(svg).toContain('<svg');
  });

  it('qrSvg honours scale (bigger scale, bigger svg)', () => {
    expect(qrSvg('x', { scale: 6 }).length).toBeGreaterThanOrEqual(qrSvg('x', { scale: 2 }).length - 1);
    expect(qrSvg('x', { scale: 6 })).toContain('<svg');
  });

  it('barcodeSvg renders a code128 barcode', () => {
    expect(barcodeSvg('ABC-12345', 'code128')).toContain('<svg');
  });
});

describe('shortUrl', () => {
  const saved = process.env.FRONT_END_WEBSITE;
  afterEach(() => {
    if (saved === undefined) delete process.env.FRONT_END_WEBSITE;
    else process.env.FRONT_END_WEBSITE = saved;
  });

  it('builds /s/<t>/<id> and trims trailing slashes', () => {
    process.env.FRONT_END_WEBSITE = 'https://app.example.com//';
    expect(shortUrl('g', 12)).toBe('https://app.example.com/s/g/12');
  });
});

describe('inventory notification links', () => {
  it('builds buyer and vendor deep links', () => {
    expect(inventoryGrn(5)).toBe('/dashboard/buyer/inventory/grn/5');
    expect(inventoryPoDeliveries(7)).toBe('/dashboard/buyer/purchase-orders/7?tab=deliveries');
    expect(inventoryAdjustment(3)).toBe('/dashboard/buyer/inventory/adjustments?id=3');
    expect(inventoryCount(4)).toBe('/dashboard/buyer/inventory/counts/4');
    expect(inventoryReorder(9)).toBe('/dashboard/buyer/inventory/reorder?hotelId=9');
    expect(vendorPoDeliveries(7)).toBe('/dashboard/vendor/purchase-orders/7?tab=deliveries');
    expect(inventoryGrn(null)).toBeNull();
  });
});
