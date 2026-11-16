const demo = (id, title, description, steps) => ({ id, title, description, steps })

export const FEATURE_DEMOS = {
  organize: [
    demo('organize', 'Combine tags', 'Find the links that belong to more than one topic.', ['Start with the full collection.', 'Select design to see matching bookmarks.', 'Add reference to show bookmarks with both tags.']),
    demo('merge', 'Merge tags', 'Preview how overlapping labels can become one.', ['Open the Tags page.', 'Select inspiration as the tag to replace.', 'Select design as the tag to keep and review the affected bookmarks before confirming.']),
  ],
  save: [
    demo('save', 'Save a bookmark', 'Add a link, its tags, and a note in the web app.', ['Open Add bookmark.', 'Enter the URL, title, tags, and description.', 'Save the link and find it again with search.']),
    demo('extensions', 'Browser extensions', 'Find the official Chrome and Firefox install options.', ['Open Settings, then Extensions.', 'Choose the official store listing for your browser.']),
  ],
  find: [
    demo('find', 'Search & sort', 'Search the details you remember, then choose a useful order.', ['Search packing to find a description about hiking essentials.', 'Search web to match titles, descriptions, and tags.', 'Open View and sort the matching links by title.']),
    demo('favorites', 'Favorites & Random', 'Return to useful links or rediscover an older bookmark.', ['Stars mark your favorite links.', 'Turn on the favorites filter.', 'Clear the filter and use Random to open a bookmark in edit mode.']),
    demo('themes', 'Three themes', 'The same collection in Slate, Midnight, and Light.', ['Browse in Slate.', 'Choose Midnight from the header.', 'Choose Light. Your selection is saved to your account.']),
    demo('preferences', 'Link preferences', 'Choose where bookmark links open.', ['Open Settings, then Preferences.', 'Select the same tab or a new tab. The extension has its own preference.']),
  ],
  share: [
    demo('share', 'Public profile', 'Share a collection that visitors can browse by tag.', ['Open Public Profile in Settings.', 'Enable your public profile to get its link.', 'Visit the profile; private bookmarks are excluded.', 'Filter the public collection by design.']),
    demo('privacy', 'Private bookmarks', 'Keep individual links out of your shared collection.', ['Locate a bookmark in your library.', 'Use its privacy control to mark it private.']),
    demo('api', 'Public JSON API', 'Get a URL for your whole shared collection or one topic.', ['Use the public API URL shown in Settings.', 'Enter design in the optional tag field to create a filtered API URL.']),
  ],
  move: [
    demo('import', 'Import bookmarks', 'Bring browser exports into your collection.', ['Choose Chrome or Firefox HTML as the import source.', 'Upload your file and preview the bookmarks.', 'Import them with their tags and descriptions.', 'Find the imported links in your library.']),
    demo('export', 'Export your library', 'Download your links, including private bookmarks and notes.', ['Open Settings, then Import / Export.', 'Choose Download JSON to keep dates, tags, favorites, privacy settings, and notes. HTML and CSV are also available.']),
  ],
}
