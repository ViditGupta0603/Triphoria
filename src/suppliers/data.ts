import type { SupplierHotel, SupplierId } from '../types';

// delhi: A wins Radison, B wins Holtin, Taj Palace is a price tie (B has higher commission)
// mumbai: partial overlap, goa: Supplier A only
export const SUPPLIER_DATA: Record<SupplierId, SupplierHotel[]> = {
  A: [
    { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
    { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
    { hotelId: 'a3', name: 'Taj Palace', price: 9500, city: 'delhi', commissionPct: 12 },
    { hotelId: 'a4', name: 'Lemon Tree', price: 4200, city: 'delhi', commissionPct: 8 },
    { hotelId: 'a5', name: 'Trident', price: 7200, city: 'mumbai', commissionPct: 12 },
    { hotelId: 'a6', name: 'Sea Princess', price: 4800, city: 'mumbai', commissionPct: 10 },
    { hotelId: 'a7', name: 'Fariyas', price: 5500, city: 'mumbai', commissionPct: 9 },
    { hotelId: 'a8', name: 'Cidade de Goa', price: 6400, city: 'goa', commissionPct: 11 },
    { hotelId: 'a9', name: 'Caravela', price: 7800, city: 'goa', commissionPct: 10 },
  ],
  B: [
    { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
    { hotelId: 'b2', name: 'Radison', price: 6100, city: 'delhi', commissionPct: 15 },
    { hotelId: 'b3', name: 'Taj Palace', price: 9500, city: 'delhi', commissionPct: 18 },
    { hotelId: 'b4', name: 'ITC Maurya', price: 11000, city: 'delhi', commissionPct: 14 },
    { hotelId: 'b5', name: 'Trident', price: 6900, city: 'mumbai', commissionPct: 16 },
    { hotelId: 'b6', name: 'Sea Princess', price: 5100, city: 'mumbai', commissionPct: 11 },
    { hotelId: 'b7', name: 'Sahara Star', price: 8800, city: 'mumbai', commissionPct: 14 },
  ],
};
