/** An adapter must use an official API or an explicit platform download/export.
 * Page scraping, credentials, signature extraction and protection bypasses do not
 * belong in this interface. New adapters must retain the shared transport policy.
 */
export interface PlatformModule {
  id: string;
  name: string;
  domains: readonly string[];
  status: 'restricted';
  description: string;
  helpUrl: string;
}

export const platformModules: PlatformModule[] = [
  { id: 'tiktok', name: 'TikTok', domains: ['tiktok.com'], status: 'restricted', description: 'Use TikTok’s creator-enabled Save video option. Post-page extraction is not supported.', helpUrl: 'https://support.tiktok.com/en/using-tiktok/exploring-videos/video-downloads' },
  { id: 'instagram', name: 'Instagram', domains: ['instagram.com'], status: 'restricted', description: 'Download your own content through Accounts Center or use a creator-authorized direct file.', helpUrl: 'https://help.instagram.com/' },
  { id: 'facebook', name: 'Facebook', domains: ['facebook.com', 'fb.watch'], status: 'restricted', description: 'Use Facebook’s download/export tools for your content. Post-page extraction is not supported.', helpUrl: 'https://www.facebook.com/help/' },
  { id: 'youtube', name: 'YouTube', domains: ['youtube.com', 'youtu.be'], status: 'restricted', description: 'Use YouTube’s official download features. Protected streams and watch-page extraction are not supported.', helpUrl: 'https://support.google.com/youtube/answer/56100' },
  { id: 'pinterest', name: 'Pinterest', domains: ['pinterest.com', 'pin.it'], status: 'restricted', description: 'Use Pinterest’s download option where offered, with permission from the rights holder.', helpUrl: 'https://help.pinterest.com/en/article/download-an-image' },
  { id: 'reddit', name: 'Reddit', domains: ['reddit.com', 'redd.it'], status: 'restricted', description: 'Use an authorized original file or Reddit’s built-in save options. Post-page extraction is not supported.', helpUrl: 'https://support.reddithelp.com/' },
  { id: 'x', name: 'X', domains: ['x.com', 'twitter.com', 't.co'], status: 'restricted', description: 'Use X’s official download option where the creator permits it. Post-page extraction is not supported.', helpUrl: 'https://help.x.com/en/using-x/x-videos' },
];

export function findPlatform(hostname: string): PlatformModule | undefined {
  return platformModules.find(platform => platform.domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`)));
}
