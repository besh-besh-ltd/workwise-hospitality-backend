import { handleGetProducts, handleGetVendors, handleGetAllHotels } from "../../models/publicModel.js";

export const getProducts = async (req, res) => {
    try {
        const { search_key } = req.query;
        const result = await handleGetProducts(search_key);

        return res.json({
            status: 1,
            data: result,
        })
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            status: 0,
            message: error.message || 'An error occurred while approving the PO.',
            error
        });
    }
};

export const getVendors = async (req, res) => {
    try {
        const { product_id } = req.query;

        const result = await handleGetVendors(product_id);

        return res.json({
            status: 1,
            data: result,
        })
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            status: 0,
            message: error.message || 'An error occurred while approving the PO.',
            error
        });
    }
};

export const getAllHotels = async (req, res) => {
    try {
        const result = await handleGetAllHotels();

        return res.json({
            status: 1,
            data: result,
        })
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            status: 0,
            message: error.message || 'An error occurred while fetching hotels.',
            error
        });
    }
};