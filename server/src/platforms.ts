/** Public page extraction shares the guarded transport. Authenticated,
 * paywalled and DRM-protected sources are never unlocked by these modules. */
export interface PlatformModule {
  id: string;
  name: string;
  domains: readonly string[];
  status: 'available' | 'restricted';
  description: string;
  helpUrl: string;
}

export const platformModules: PlatformModule[] = [
  { id: 'tiktok', name: 'TikTok', domains: ['tiktok.com'], status: 'available', description: 'Public video links can be resolved when the source makes media accessible. Login-only and protected posts are unsupported.', helpUrl: 'https://support.tiktok.com/en/using-tiktok/exploring-videos/video-downloads' },
  { id: 'instagram', name: 'Instagram', domains: ['instagram.com'], status: 'available', description: 'Public reels and video posts are supported where accessible without login. Availability depends on the source.', helpUrl: 'https://help.instagram.com/' },
  { id: 'facebook', name: 'Facebook', domains: ['facebook.com', 'fb.watch'], status: 'available', description: 'Public video pages are supported where accessible without login. Private groups and protected posts are unsupported.', helpUrl: 'https://www.facebook.com/help/' },
  { id: 'youtube', name: 'YouTube', domains: ['youtube.com', 'youtu.be'], status: 'available', description: 'Public videos offer the available source qualities with audio. Login, regional restrictions and DRM are not bypassed.', helpUrl: 'https://support.google.com/youtube/answer/56100' },
  { id: 'pinterest', name: 'Pinterest', domains: ['pinterest.com', 'pin.it'], status: 'available', description: 'Public video pins are resolved when an accessible original video is provided.', helpUrl: 'https://help.pinterest.com/en/article/download-an-image' },
  { id: 'reddit', name: 'Reddit', domains: ['reddit.com', 'redd.it'], status: 'available', description: 'Public video posts can combine separate source video and audio into one download.', helpUrl: 'https://support.reddithelp.com/' },
  { id: 'x', name: 'X', domains: ['x.com', 'twitter.com', 't.co'], status: 'available', description: 'Public video posts are resolved where accessible. Protected accounts and login-only media are unsupported.', helpUrl: 'https://help.x.com/en/using-x/x-videos' },
];

export function findPlatform(hostname: string): PlatformModule | undefined {
  return platformModules.find(platform => platform.domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`)));
}
