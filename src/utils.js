import listugcposts from "./listugcposts.js";
import { SortEnum } from "./types.js";
import { URL } from "url";
import parser from "./parser.js";

/**
 * Validates parameters for the Google Maps review scraper.
 *
 * @param {string} url - Must include "https://www.google.com/maps/place/".
 * @param {string} sort_type - Must be a valid key in SortEnum.
 * @param {string|number} pages - "max" or a number.
 * @param {boolean} clean - Must be a boolean.
 * @throws {Error} If any parameter is invalid.
 */
export function validateParams(url, sort_type, pages, clean) {
    const parsedUrl = new URL(url);
    if (parsedUrl.host !== "www.google.com" || !parsedUrl.pathname.startsWith("/maps/place/")) {
        throw new Error(`Invalid URL: ${url}`);
    }
    if (!SortEnum[sort_type]) {
        throw new Error(`Invalid sort type: ${sort_type}`);
    }
    if (pages !== "max" && isNaN(pages)) {
        throw new Error(`Invalid pages value: ${pages}`);
    }
    if (typeof clean !== "boolean") {
        throw new Error(`Invalid value for 'clean': ${clean}`);
    }
}

/**
 * Fetches reviews from a given URL with sorting and pagination options.
 *
 * @param {string} url - The URL to fetch reviews from.
 * @param {string} sort - The sorting option for the reviews.
 * @param {string} [nextPage=""] - Token for the next page, if any.
 * @param {string} [search_query=""] - Search query to filter reviews, if any.
 * @returns {Promise<Object>} Parsed JSON data of reviews.
 * @throws {Error} If the request fails or the response is invalid.
 */
export async function fetchReviews(url, sort, nextPage = "", search_query = "") {
    const apiUrl = listugcposts(url, sort, nextPage, search_query);
    
    // Cookie support: Google requires cookies for the API to work
    // Set GOOGLE_MAPS_COOKIES env var with cookies from Firefox DevTools
    const cookies = process.env.GOOGLE_MAPS_COOKIES || "";
    const headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0"
    };
    if (cookies) {
        headers["Cookie"] = cookies;
    }
    
    const response = await fetch(apiUrl, { headers });
    if (!response.ok) {
        throw new Error(`Failed to fetch reviews: ${response.statusText}`);
    }
    const textData = await response.text();
    const rawData = textData.split(")]}'")[1];
    return JSON.parse(rawData);
}


/**
 * Fetches a page with exponential backoff retry on failure.
 * 
 * @param {string} url - The URL to fetch reviews from.
 * @param {string} sort - Sorting parameter for reviews.
 * @param {string} nextPage - Token for the next page.
 * @param {string} search_query - Search query to filter reviews.
 * @param {number} maxRetries - Maximum number of retries (default: 3).
 * @param {number} baseDelay - Base delay in ms for exponential backoff (default: 2000).
 * @returns {Promise<Object|null>} Parsed data or null if all retries failed.
 */
async function fetchWithRetry(url, sort, nextPage, search_query, maxRetries = 3, baseDelay = 2000) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const data = await fetchReviews(url, sort, nextPage, search_query);
            
            // Check if we got valid review data
            if (Array.isArray(data[2]) && data[2].length > 0) {
                return data;
            }
            
            // Got empty/null data - might be rate limited
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt); // 2s, 4s, 8s
                console.log(`Page returned empty data. Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } catch (err) {
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt);
                console.log(`Fetch error: ${err.message}. Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.log(`Fetch failed after ${maxRetries} retries: ${err.message}`);
                return null;
            }
        }
    }
    return null; // All retries exhausted with empty data
}

/**
 * Paginates through reviews from a given URL.
 *
 * @param {string} url - The URL to fetch reviews from.
 * @param {string} sort - Sorting parameter for reviews.
 * @param {string|number} pages - Number of pages or "max".
 * @param {string} search_query - Search query to filter reviews.
 * @param {boolean} clean - Whether to clean and parse the data.
 * @param {Array} initialData - Initial data containing reviews and next page token.
 * @returns {Promise<Array>} Array of reviews or parsed reviews.
 */
export async function paginateReviews(url, sort, pages, search_query, clean, initialData) {
    let reviews = initialData[2] || [];
    let nextPage = initialData[1]?.replace(/"/g, "");
    
    console.log(`Initial page: ${initialData[2]?.length || 0} reviews`);
    
    let currentPage = 2;
    while (nextPage && (pages === "max" || currentPage <= +pages)) {
        console.log(`Scraping page ${currentPage}...`);
        
        const data = await fetchWithRetry(url, sort, nextPage, search_query);
        
        if (!data || !Array.isArray(data[2])) {
            console.log(`Page ${currentPage}: No more data after retries. Returning ${reviews.length} reviews.`);
            break;
        }
        
        console.log(`Page ${currentPage}: ${data[2].length} reviews`);
        reviews = [...reviews, ...data[2]];
        nextPage = data[1]?.replace(/"/g, "");
        
        if (!nextPage) {
            console.log(`Pagination complete - no more pages.`);
            break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000)); // Standard delay between pages
        currentPage++;
    }
    
    console.log(`Total reviews collected: ${reviews.length}`);
    return clean ? await parser(reviews) : reviews;
}