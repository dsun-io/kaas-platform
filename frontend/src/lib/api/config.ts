export const API_MODE = process.env.NEXT_PUBLIC_API_MODE || 'mock';
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

export const isMockMode = API_MODE === 'mock';
