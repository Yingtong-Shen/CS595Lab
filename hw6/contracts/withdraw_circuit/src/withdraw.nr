use dep::merkle_trees::compute_merkle_root;
use dep::std::hash::pedersen_hash;

fn main(
    r: Field,
    index: Field,
    hashpath: [Field; 8],

    root: pub Field,
    id: pub Field,
) {
    let commitment = pedersen_hash([id, r]);
    let computed_root = compute_merkle_root(commitment, index, hashpath);
    assert(computed_root == root);
}