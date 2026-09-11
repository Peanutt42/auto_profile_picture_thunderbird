import defaultSettings from "../settings/defaultSettings.js";
import Author from "./Author.js";
import ProfilePictureFetcher from "./ProfilePictureFetcher.js";

/**
 * Service for managing avatar URLs.
 */
export default class AvatarService {
  constructor() {
    /**
     * Cache for storing avatar URLs for the session.
     * @type {Object.<string, string>}
     */
    this.sessionCacheAvatarUrls = {};
    /**
     * In-flight avatar fetches, keyed like the session cache. Concurrent
     * callers share the same promise instead of polling.
     * @type {Object.<string, Promise<string|null>>}
     */
    this.pendingAvatarFetches = {};
  }

  /**
   * Returns the number of avatars that are currently being fetched.
   * @returns {number} - The number of avatars being fetched.
   */
  countWaitingAvatars() {
    return Object.keys(this.pendingAvatarFetches).length;
  }

  /**
   * Retrieves the avatar URL for the given author.
   *
   * Steps:
   * 1. Check if the avatar URL is already in the session cache
   * 2. If a fetch for the author is already in flight, share its promise
   * 3. Otherwise:
   *    a. Check if we're already processing too many requests
   *    b. Fetch and store the avatar URL in the cache
   * 4. Return the cached avatar URL
   *
   * @param {Author} author - The author for whom to fetch the avatar URL.
   * @returns {Promise<string|null>} - The avatar URL or null if request limit exceeded or not found.
   */
  async getAvatar(author) {
    const lcAuthor = author.getAuthor().toLowerCase();
    if (this.sessionCacheAvatarUrls[lcAuthor]) {
      return this.sessionCacheAvatarUrls[lcAuthor];
    }
    if (this.pendingAvatarFetches[lcAuthor]) {
      return this.pendingAvatarFetches[lcAuthor];
    }
    if (this.countWaitingAvatars() > defaultSettings.MAX_REQUEST_SIZE) {
      console.warn(
        "Too many requests in progress, skipping avatar fetch for " +
          author.getAuthor(),
      );
      return null;
    }
    const fetchPromise = (async () => {
      try {
        const profilePictureFetcher = new ProfilePictureFetcher(
          window,
          author,
        );
        const url = await profilePictureFetcher.getAvatar();
        this.sessionCacheAvatarUrls[lcAuthor] = url;
        return url;
      } finally {
        delete this.pendingAvatarFetches[lcAuthor];
      }
    })();
    this.pendingAvatarFetches[lcAuthor] = fetchPromise;
    return fetchPromise;
  }
}
