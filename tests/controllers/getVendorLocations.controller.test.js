
import vendorController from "../../app/controllers/admin/vendorController.js";
import { VendorModel } from "../../__mocks__/VendorModel.js";

jest.mock("../../../app/models/VendorModel.js", () => ({
  VendorModel
}));

describe("getVendorLocations Controller", () => {
  test("should return vendor locations", async () => {
    const mockData = [{ city: "Delhi", state: "Delhi" }];

    VendorModel.getVendorLocationsById.mockResolvedValue(mockData);

    const req = { params: { id: 1 } };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await vendorController.getVendorLocations(req, res);

    expect(VendorModel.getVendorLocationsById).toHaveBeenCalledWith(1);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: mockData,
    });
  });
});
