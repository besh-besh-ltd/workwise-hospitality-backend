import { fetchPublicUsers, handleAddPublicUsers, handleGetProducts, handleGetVendors } from "../../models/publicModel.js";

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


export const addPublicUsers = async (req , res ) =>{
    try {
        const { username, email, mobile, company_name , platform , element } = req.body;


        const publicUserData = {
            username,
            email,
            mobile,
            company_name,
            platform,
            element
        }

        await handleAddPublicUsers(publicUserData);
        res.status(200).json({
            status: 1,
            message: "Public user added successfully"
        })
    } catch (error) {
        res.status(500).json({
            status: 0,
            message: "An error occurred while adding public user",
            error: error.message
        })
    }
}

export const getPublicUsers = async (req, res) => {
  try {
    // Extract query params
    const {
      page = 1,
      limit = 10,
      start_date,
      end_date
    } = req.query;

    // Validate pagination numbers
    const pageNumber = parseInt(page, 10);
    const limitNumber = parseInt(limit, 10);

    if (isNaN(pageNumber) || pageNumber <= 0) {
      return res.status(400).json({
        status: 0,
        message: "Invalid page number"
      });
    }

    if (isNaN(limitNumber) || limitNumber <= 0) {
      return res.status(400).json({
        status: 0,
        message: "Invalid limit value"
      });
    }

    // Validate date if provided
    if ((start_date && isNaN(Date.parse(start_date))) ||
        (end_date && isNaN(Date.parse(end_date)))) {
      return res.status(400).json({
        status: 0,
        message: "Invalid date format provided"
      });
    }

    // Build filters
    const filters = {
      page: pageNumber,
      limit: limitNumber,
      startDate: start_date || null,
      endDate: end_date || null
    };

    const results = await fetchPublicUsers(filters);

    return res.status(200).json({
      status: 1,
      message: "Public users fetched successfully",
      data: results
    });

  } catch (error) {
    console.error("Error fetching public users:", error);

    return res.status(500).json({
      status: 0,
      message: "An error occurred while fetching public users",
      error: error.message
    });
  }
};
