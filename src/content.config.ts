import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const linkSchema = z.object({
  label: z.string(),
  url: z.url(),
});

const achievementSchema = z.object({
  title: z.string(),
  type: z.string(),
  description: z.string().optional(),
  date: z.coerce.date().optional(),
  work: z.string().optional(),
  url: z.url().optional(),
  organization: z.string().optional(),
});

const galleryImageSchema = z.object({
  src: z.string(),
  alt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  category: z.string(),
});

const events = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/events" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    location: z.string(),
    format: z.enum(["online", "offline", "hybrid"]),
    status: z.enum(["upcoming", "ongoing", "finished"]),
    tags: z.array(z.string()).default([]),
    project: z.string().optional(),
    registrationUrl: z.url().optional(),
    organizers: z.array(z.string()).default([]),
    partners: z.array(z.string()).default([]),
    sponsors: z.array(z.string()).default([]),
    thumbnail: z.string().optional(),
    featured: z.boolean().default(false),
    theme: z.string().optional(),
    externalLinks: z.array(linkSchema).default([]),
  }),
});

const projects = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/projects" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    status: z.enum(["planned", "ongoing", "completed", "paused"]),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    thumbnail: z.string().optional(),
    featured: z.boolean().default(false),
    events: z.array(z.string()).default([]),
    works: z.array(z.string()).default([]),
    creators: z.array(z.string()).default([]),
    externalLinks: z.array(linkSchema).default([]),
  }),
});

const works = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/works" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    type: z.string(),
    tags: z.array(z.string()).default([]),
    releaseDate: z.coerce.date().optional(),
    firstPresentedAt: z.string().optional(),
    thumbnail: z.string().optional(),
    thumbnailWidth: z.number().int().positive().optional(),
    thumbnailHeight: z.number().int().positive().optional(),
    images: z.array(z.string()).default([]),
    creators: z.array(z.string()).default([]),
    projects: z.array(z.string()).default([]),
    events: z.array(z.string()).default([]),
    credits: z.array(z.string()).default([]),
    externalLinks: z.array(linkSchema).default([]),
    purchaseUrl: z.url().optional(),
    purchaseLabel: z.string().optional(),
    featured: z.boolean().default(false),
  }),
});

const creators = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/creators" }),
  schema: z.object({
    name: z.string(),
    profile: z.string(),
    tagline: z.string().optional(),
    profileImage: z.string().optional(),
    fields: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    works: z.array(z.string()).default([]),
    projects: z.array(z.string()).default([]),
    events: z.array(z.string()).default([]),
    achievements: z.array(achievementSchema).default([]),
    gallery: z.array(galleryImageSchema).default([]),
    portfolioUrl: z.url().optional(),
    website: z.url().optional(),
    github: z.url().optional(),
    x: z.url().optional(),
    instagram: z.url().optional(),
    otherLinks: z.array(linkSchema).default([]),
    featured: z.boolean().default(false),
  }),
});

const activities = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/activities" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    type: z.string(),
    tags: z.array(z.string()).default([]),
    event: z.string().optional(),
    project: z.string().optional(),
    externalUrl: z.url().optional(),
  }),
});

export const collections = { events, projects, works, creators, activities };
