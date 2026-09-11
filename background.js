import SettingsManager from "./settings/SettingsManager.js";
import Author from "./src/Author.js";
import AvatarService from "./src/AvatarService.js";
import CacheStorage from "./src/CacheStorage.js";
import ContactsService from "./src/ContactsService.js";
import MailService from "./src/MailService.js";
import MessagesService from "./src/MessagesService.js";
import RecipientInitial from "./src/RecipientInitial.js";

const cache = new CacheStorage();
const settingsManager = new SettingsManager(cache);

let inboxListEnabled, contactsIntegrationEnabled;

/**
 * Refreshes the settings from the SettingsManager
 */
async function refreshSettings() {
  inboxListEnabled = await settingsManager.getInboxListEnabled();
  contactsIntegrationEnabled =
    await settingsManager.getContactsIntegrationEnabled();
}
await refreshSettings();

const avatarService = new AvatarService();
const mailService = new MailService(avatarService);
const contactsService = new ContactsService(mailService, avatarService);
const messagesService = new MessagesService(mailService, avatarService);

/**
 * Handles the need for additional data in a tab
 * @param {Object} tab Tab object
 * @param {Object} result Result object containing data
 */
async function handleNeedData(tab, result) {
  const dataPopups = result.data.popupValues;
  const urlsDict = {};
  for (const popup of dataPopups) {
    const mail = popup.mail;
    const author = await Author.fromAuthor(mail);
    const url = await avatarService.getAvatar(author);
    urlsDict[mail] = url;
  }
  const payload = {
    urls: urlsDict,
    data: result.data,
  };
  browser.headerApi.pictureHeadersConversation(tab.id, JSON.stringify(payload));
}

/**
 * Displays avatars in a tab
 *
 * Uses a two-phase paint so the header never sits empty while the (possibly
 * slow: contacts lookup, storage reads, network) avatar fetch runs:
 * 1. Synchronously built initials are injected immediately (no I/O).
 * 2. The fetched avatar is injected afterwards and upgrades the initials
 *    in place (installOnMessageHeader replaces initials with the image).
 * A per-tab token drops stale results when the user clicks through mails
 * faster than fetches resolve.
 * @param {Object} tab Tab object
 * @param {Array} messages Array of message objects
 */
const headerDisplayTokens = {};
async function displayInTab(tab, messages) {
  const token = (headerDisplayTokens[tab.id] =
    (headerDisplayTokens[tab.id] || 0) + 1);

  // Resolve correspondents once and reuse them for both phases so we don't
  // pay the (possibly getFull-based) resolution cost twice.
  let authors = [];
  try {
    authors = await Promise.all(
      messages.map((message) =>
        mailService.getCorrespondent(message, "messageHeader"),
      ),
    );
  } catch (error) {
    console.warn("Error resolving correspondents for header:", error);
    return;
  }
  if (token !== headerDisplayTokens[tab.id]) {
    return;
  }

  // Phase 1: instant initials paint (pure computation, no I/O).
  try {
    const initialsDict = {};
    for (const author of authors) {
      initialsDict[author.getEmail()] =
        RecipientInitial.buildInitials(author);
    }
    // Dispatched first and intentionally not awaited: the upgrade in phase 2
    // is sent over the same channel afterwards, preserving order.
    browser.headerApi
      .pictureHeaders(tab.id, JSON.stringify(initialsDict))
      .catch((error) =>
        console.warn("Error painting header initials:", error),
      );
  } catch (error) {
    console.warn("Error painting header initials:", error);
  }

  // Phase 2: fetch real avatars (session/persistent cache or network) and
  // upgrade the initials in place.
  let urlsDict = {};
  for (const author of authors) {
    let url = await avatarService.getAvatar(author);
    if (!url) {
      url = RecipientInitial.buildInitials(author);
    }
    urlsDict[author.getEmail()] = url;
  }
  if (token !== headerDisplayTokens[tab.id]) {
    // User already moved to another message; don't paint stale avatars.
    return;
  }
  const urlDictJSON = JSON.stringify(urlsDict);
  const result = await browser.headerApi.pictureHeaders(tab.id, urlDictJSON);

  if (result.status === "needData") {
    handleNeedData(tab, result);
  }
}

/**
 * Handles the creation of a new contact
 * @param {Object} contactNode Contact node object
 */
async function onContactCreated(contactNode) {
  if (!contactsIntegrationEnabled) return;
  await contactsService.handleContactCreated(contactNode);
}

/**
 * Displays the inbox list in a tab
 * @param {Object} tab Tab object
 */
async function displayInboxList(tab) {
  if (!inboxListEnabled) return;
  try {
    await messagesService.displayInboxList(tab);
  } catch (error) {
    console.warn("Error in displayInboxList:", error);
  }
}

/**
 * Initializes event listeners
 */
function initListeners() {
  browser.messageDisplay.onMessageDisplayed.addListener(
    async (tab, message) => {
      displayInTab(tab, [message]);
      displayInboxList(tab);
    },
  );

  browser.messageDisplay.onMessagesDisplayed.addListener(
    async (tab, messages) => {
      displayInTab(tab, messages);
    },
  );

  browser.mailTabs.onDisplayedFolderChanged.addListener((tab) => {
    displayInboxList(tab);
  });

  browser.messages.onNewMailReceived.addListener(async (_folder, _messages) => {
    setTimeout(async () => {
      const currentTab = await browser.tabs.getCurrent();
      displayInboxList(currentTab);
    }, 1000);
  });

  browser.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
    if (tab.type !== "mail") {
      return;
    }
    displayInboxList(tab);
  });

  browser.runtime.onMessage.addListener(async (message, _sender) => {
    if (message.action === "displayInboxList") {
      displayInboxList();
    } else if (message.action === "refreshSettings") {
      refreshSettings();
    }
  });

  messenger.contacts.onCreated.addListener(onContactCreated);

  browser.tabs.onUpdated.addListener(async (tabId, _changeInfo, tab) => {
    if (tab.status === "complete" && tab.type === "special") {
      // Thunderbird Conversations tab
      const result = await browser.headerApi.pictureHeaders(tabId, "{}");
      if (result.status === "needData") {
        handleNeedData(tab, result);
      }
    }
  });
}

initListeners();
if (inboxListEnabled) {
  displayInboxList();
}
