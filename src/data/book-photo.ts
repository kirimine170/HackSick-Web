// Regions are normalized to the close-up photograph．Keep the featured book and stacks visible．
export const anokotoPhotoMask: { clearArea: [number, number][]; mosaicAreas: [number, number][][] } = {
  clearArea: [[0.19,0.449],[0.50,0.31],[0.837,0.729],[0.47,0.939]],
  mosaicAreas: [
    [[0,0],[0.09,0],[0.283,0.226],[0,0.36]],
    [[0.085,0],[0.34,0],[0.468,0.17],[0.282,0.235]],
    [[0.335,0],[0.70,0],[0.72,0.055],[0.475,0.143]],
    [[0.72,0],[1,0],[1,0.25]],
    [[0.469,0.13],[0.727,0.022],[1,0.292],[1,0.363],[0.72,0.482]],
    [[0,0.378],[0.19,0.445],[0.47,0.94],[0.295,1],[0,1]],
  ],
};
